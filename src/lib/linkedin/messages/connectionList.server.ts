import { and, count, desc, eq, exists, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { crmConversations, crmRecords } from "@/lib/crm/schema";
import { companies, people } from "@/lib/leads/schema";
import { personProfile } from "@/lib/leads/variables";
import { campaigns, connections, leads, linkedInAccounts, messages } from "@/lib/linkedin/schema";
import { clampPage, pageSlice } from "@/lib/linkedin/pagination";
import {
  CONNECTIONS_ONLY_FILTER,
  UNREPLIED_FILTER,
  connectionPageSize,
  isAllLeadsFilter,
  mapConnectionToItem,
  type ConnectionListFilters,
  type ConnectionRow,
} from "./connectionList";
import { loadInboxCrmSummaries } from "./crmContext.server";
import type { LeadStatus } from "@/lib/linkedin/schema";

/**
 * Server-only readers for the messages list. Kept apart from ./connectionList
 * so client components can import that module's constants and types without
 * dragging the postgres driver into the browser bundle.
 */

/**
 * Aliases for the two LinkedInAccount joins (the connection's own account and
 * the lead's account) and for the lead's campaign — Prisma nested these under
 * `include`; in SQL they are separate joins onto the same tables.
 */
const connectionAccount = sql`"connAccount"`;
const leadAccount = sql`"leadAccount"`;

/**
 * When the conversation last moved: its newest message, else when the
 * connection was made. Sorting and the period filter use this, not
 * Connection.updatedAt, which a sync bumps for every conversation at once.
 */
const lastActivityAt = sql`COALESCE((
  SELECT MAX(m."createdAt") FROM ${messages} m
  WHERE m."connectionId" = ${connections.id} AND m."duplicateOfMessageId" IS NULL
), ${connections.connectedAt})`;

export const buildConnectionListWhere = (filters: ConnectionListFilters): SQL | undefined => {
  const conditions: SQL[] = [inOrg(connections)];

  // Personal campaigns are private outreach — their leads never surface in the Messages tab.
  // `isNot` in Prisma is also satisfied when the relation itself is absent, so a lead with
  // no campaign (or no lead at all) still passes.
  conditions.push(
    or(
      isNull(connections.leadId),
      sql`NOT EXISTS (
        SELECT 1 FROM ${leads}
        JOIN ${campaigns} ON ${campaigns.id} = ${leads.campaignId}
        WHERE ${leads.id} = ${connections.leadId} AND ${campaigns.type} = 'PERSONAL'
      )`
    )!
  );

  if (filters.campaignId) {
    conditions.push(
      exists(
        db
          .select({ one: leads.id })
          .from(leads)
          .where(and(eq(leads.id, connections.leadId), eq(leads.campaignId, filters.campaignId)))
      )
    );
  }

  if (filters.accountId) {
    conditions.push(
      or(
        eq(connections.linkedinAccountId, filters.accountId),
        exists(
          db
            .select({ one: leads.id })
            .from(leads)
            .where(
              and(
                eq(leads.id, connections.leadId),
                eq(leads.linkedinAccountId, filters.accountId)
              )
            )
        )
      )!
    );
  }

  if (filters.status === UNREPLIED_FILTER || filters.status === "REPLIED") {
    // Needs reply: they wrote last. Replied: you answered last, in a
    // conversation where they had written. The two never overlap.
    // Resolve the latest canonical message for all conversations in one pass.
    // A correlated lookup here becomes prohibitively slow on migrated history
    // because legacy databases may not have a Message.connectionId index.
    const theyWroteLast = filters.status === UNREPLIED_FILTER;
    conditions.push(sql`${connections.id} IN (
      SELECT latest."connectionId"
      FROM (
        SELECT DISTINCT ON (m."connectionId")
          m."connectionId",
          m."type"
        FROM ${messages} m
        WHERE m."connectionId" IS NOT NULL
          AND m."organizationId" = ${currentOrganizationId()}
          AND m."duplicateOfMessageId" IS NULL
        ORDER BY m."connectionId", m."createdAt" DESC, m."id" DESC
      ) latest
      WHERE ${theyWroteLast ? sql`latest."type" = 'RECEIVED'` : sql`latest."type" <> 'RECEIVED'`}
    )`);
    if (!theyWroteLast) {
      conditions.push(
        exists(
          db
            .select({ one: messages.id })
            .from(messages)
            .where(and(eq(messages.connectionId, connections.id), eq(messages.type, "RECEIVED")))
        )
      );
    }
  } else if (filters.status === CONNECTIONS_ONLY_FILTER) {
    conditions.push(isNull(connections.leadId));
  } else if (filters.status && !isAllLeadsFilter(filters.status)) {
    conditions.push(
      exists(
        db
          .select({ one: leads.id })
          .from(leads)
          .where(
            and(
              eq(leads.id, connections.leadId),
              eq(leads.status, filters.status as LeadStatus)
            )
          )
      )
    );
  }
  // "All" is every conversation, campaign lead or not.

  if (filters.periodDays) {
    const cutoff = new Date(Date.now() - filters.periodDays * 86_400_000);
    conditions.push(sql`${lastActivityAt} >= ${cutoff}`);
  }

  if (filters.categoryKey || filters.subcategoryId) {
    // A connection carries a CRM classification through its active linkedin
    // conversation. account_ref is the Unipile account id, so the connection's
    // LinkedInAccount row is consulted for its linkedinId.
    conditions.push(
      exists(
        db
          .select({ one: crmConversations.id })
          .from(crmConversations)
          .innerJoin(crmRecords, eq(crmRecords.id, crmConversations.crmRecordId))
          .where(
            and(
              inOrg(crmConversations),
              eq(crmConversations.channel, "linkedin"),
              eq(crmConversations.status, "active"),
              eq(crmConversations.providerThreadId, connections.chatId),
              eq(
                crmConversations.accountRef,
                db
                  .select({ linkedinId: linkedInAccounts.linkedinId })
                  .from(linkedInAccounts)
                  .where(eq(linkedInAccounts.id, connections.linkedinAccountId))
              ),
              filters.categoryKey ? eq(crmRecords.categoryKey, filters.categoryKey) : undefined,
              filters.subcategoryId ? eq(crmRecords.subcategoryId, filters.subcategoryId) : undefined
            )
          )
      )
    );
  }

  const q = filters.search?.trim();
  if (q) {
    conditions.push(
      or(
        ilike(connections.name, `%${q}%`),
        ilike(connections.linkedinUrl, `%${q}%`),
        sql`exists (
          select 1 from "Lead" l
          join people p on p.id = l."personId"
          left join companies c on c.id = p.company_id and c.organization_id = ${currentOrganizationId()}
          where l.id = ${connections.leadId}
            and p.organization_id = ${currentOrganizationId()}
            and (
              p.linkedin_url ilike ${`%${q}%`}
              or p.email ilike ${`%${q}%`}
              or p.first_name ilike ${`%${q}%`}
              or p.last_name ilike ${`%${q}%`}
              or p.full_name ilike ${`%${q}%`}
              or p.title ilike ${`%${q}%`}
              or p.raw::text ilike ${`%${q}%`}
              or c.name ilike ${`%${q}%`}
              or c.domain ilike ${`%${q}%`}
            )
        )`
      )!
    );
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
};

export const listConnectionsPage = async (page: number, filters: ConnectionListFilters = {}) => {
  const where = buildConnectionListWhere(filters);
  const [{ n: totalCount }] = await db
    .select({ n: count() })
    .from(connections)
    .where(where);
  const resolvedPage = clampPage(page, totalCount);
  const { skip, take } = pageSlice(resolvedPage);

  // The two message aggregates Prisma expressed as `messages: { take: 1 }` and
  // `_count: { messages: { where: { seen: false } } }` become correlated
  // subqueries — one lateral-style lookup of the newest message, one count.
  const rows = await db
    .select({
      id: connections.id,
      name: connections.name,
      headline: connections.headline,
      profilePictureUrl: connections.profilePictureUrl,
      linkedinUrl: connections.linkedinUrl,
      providerId: connections.providerId,
      chatId: connections.chatId,
      connectedAt: connections.connectedAt,
      person: people,
      company: companies,
      accountId: sql<string | null>`${connectionAccount}."id"`,
      accountUsername: sql<string | null>`${connectionAccount}."username"`,
      accountName: sql<string | null>`${connectionAccount}."name"`,
      accountPicture: sql<string | null>`${connectionAccount}."profilePictureUrl"`,
      leadStatus: sql<string | null>`${leads.status}`,
      campaignId: sql<string | null>`${campaigns.id}`,
      campaignName: sql<string | null>`${campaigns.name}`,
      leadAccountId: sql<string | null>`${leadAccount}."id"`,
      leadAccountUsername: sql<string | null>`${leadAccount}."username"`,
      leadAccountName: sql<string | null>`${leadAccount}."name"`,
      leadAccountPicture: sql<string | null>`${leadAccount}."profilePictureUrl"`,
      lastMessageText: sql<string | null>`(
        SELECT m."text" FROM ${messages} m
        WHERE m."connectionId" = ${connections.id}
          AND m."duplicateOfMessageId" IS NULL
        ORDER BY m."createdAt" DESC, m."id" DESC LIMIT 1
      )`,
      lastMessageType: sql<string | null>`(
        SELECT m."type" FROM ${messages} m
        WHERE m."connectionId" = ${connections.id}
          AND m."duplicateOfMessageId" IS NULL
        ORDER BY m."createdAt" DESC, m."id" DESC LIMIT 1
      )`,
      lastMessageCreatedAt: sql<Date | null>`(
        SELECT m."createdAt" FROM ${messages} m
        WHERE m."connectionId" = ${connections.id}
          AND m."duplicateOfMessageId" IS NULL
        ORDER BY m."createdAt" DESC, m."id" DESC LIMIT 1
      )`,
      unseenCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${messages} m
        WHERE m."connectionId" = ${connections.id}
          AND m."duplicateOfMessageId" IS NULL
          AND m."seen" = false
      )`,
    })
    .from(connections)
    .leftJoin(
      sql`"LinkedInAccount" AS ${connectionAccount}`,
      sql`${connectionAccount}."id" = ${connections.linkedinAccountId}`
    )
    .leftJoin(leads, eq(leads.id, connections.leadId))
    .leftJoin(people, eq(leads.personId, people.id))
    .leftJoin(companies, eq(people.companyId, companies.id))
    .leftJoin(campaigns, eq(campaigns.id, leads.campaignId))
    .leftJoin(
      sql`"LinkedInAccount" AS ${leadAccount}`,
      sql`${leadAccount}."id" = ${leads.linkedinAccountId}`
    )
    .where(where)
    .orderBy(sql`${lastActivityAt} DESC NULLS LAST`, desc(connections.updatedAt))
    .offset(skip)
    .limit(take);

  const shaped: ConnectionRow[] = rows.map((r) => {
    const profile = r.person ? personProfile(r.person, r.company) : null;
    return {
      id: r.id,
      name: profile?.name ?? r.name,
      headline: profile?.headline ?? r.headline,
      profilePictureUrl: profile?.profilePictureUrl ?? r.profilePictureUrl,
      linkedinUrl: profile?.linkedinUrl || r.linkedinUrl,
      providerId: r.providerId,
      chatId: r.chatId,
      connectedAt: r.connectedAt,
      linkedInAccount: r.accountId
        ? {
            id: r.accountId,
            username: r.accountUsername!,
            name: r.accountName,
            profilePictureUrl: r.accountPicture,
          }
        : null,
      lead: r.leadStatus
        ? {
            status: r.leadStatus,
            campaign: r.campaignId ? { id: r.campaignId, name: r.campaignName! } : null,
            linkedInAccount: r.leadAccountId
              ? {
                  id: r.leadAccountId,
                  username: r.leadAccountUsername!,
                  name: r.leadAccountName,
                  profilePictureUrl: r.leadAccountPicture,
                }
              : null,
          }
        : null,
      messages:
        r.lastMessageText !== null && r.lastMessageCreatedAt !== null
          ? [
              {
                text: r.lastMessageText,
                type: r.lastMessageType!,
                createdAt: new Date(r.lastMessageCreatedAt),
              },
            ]
          : [],
      _count: { messages: Number(r.unseenCount) },
    };
  });

  const crmSummaries = await loadInboxCrmSummaries(
    shaped.map((c) => ({ id: c.id, chatId: c.chatId, linkedInAccountId: c.linkedInAccount?.id ?? null }))
  );
  const items = shaped.map((c) => {
    const item = mapConnectionToItem(c);
    item.crm = crmSummaries.get(c.id) ?? null;
    return item;
  });

  return {
    connections: items,
    totalCount,
    page: resolvedPage,
    pageSize: connectionPageSize,
    hasMore: resolvedPage * connectionPageSize < totalCount,
  };
};

export const countUnreadFromRepliedLeads = async (): Promise<number> => {
  const [row] = await db
    .select({ n: count() })
    .from(messages)
    .where(
      and(
        inOrg(messages),
        eq(messages.seen, false),
        eq(messages.type, "RECEIVED"),
        exists(
          db
            .select({ one: leads.id })
            .from(leads)
            .where(
              and(
                eq(leads.id, messages.leadId),
                eq(leads.status, "REPLIED"),
                // `campaign: { isNot: { type: PERSONAL } }` — also true when the
                // lead has no campaign at all.
                sql`NOT EXISTS (
                  SELECT 1 FROM ${campaigns}
                  WHERE ${campaigns.id} = ${leads.campaignId}
                    AND ${campaigns.type} = 'PERSONAL'
                )`
              )
            )
        )
      )
    );
  return row.n;
};
