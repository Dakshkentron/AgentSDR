import { isPlatformConnected } from "@/lib/platform/credentials";
import { and, asc, eq, exists, gte, isNotNull, ne, sql, count as sqlCount } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { personVariables } from "@/lib/leads/variables";
import { fillTemplate } from "@/lib/outreach/render";
import { campaigns, connections, leads, linkedInAccounts, messages } from "@/lib/linkedin/schema";
import { extractApiErrorDetail, serializeError } from "@/lib/linkedin/serializeError";
import {
  isInvitationMessageTooLong,
  MAX_INVITATION_MESSAGE_LENGTH,
  invitationMessageLength,
} from "@/lib/linkedin/invitationMessage";
import { resetLeadRetryCount } from "@/lib/linkedin/inviteRetry.server";
import { logInviteSendDiagnostics } from "@/lib/linkedin/logInvitePipelineDiagnostics";
import { pendingLeadsSendableByAccount } from "@/lib/linkedin/leadOutreachEligibility";
import { sendConnectionRequest } from "@/services/unipile.service";
import { UnsuccessfulRequestError } from "unipile-node-sdk";
import type { LinkedInAccount } from "@/lib/linkedin/schema";
import { isPersonDoNotContact } from "@/lib/crm/policies";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { channelRules } from "@/lib/channels/rules.server";
import { pickInRange } from "@/lib/channels/rules";

// Daily limits, run sizes and delays come from Settings → LinkedIn → Sending
// rules (src/lib/channels/rules.ts); an account's own dailyInviteLimit wins.

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

const getTodayStart = (): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const isAccountLimitError = (err: unknown): boolean => {
  if (!(err instanceof UnsuccessfulRequestError)) return false;
  // Real limit phrases only: a bare "limit"/"quota" also matches URLs (limit=100) and endpoint
  // names (verifyQuotaAndCreateV2), which paused accounts on unrelated failures.
  return /weekly|invitation[_ ]?limit|limit[_ ](reached|exceeded)|quota[_ ](reached|exceeded)|exceeded[^.]*(limit|quota)|too many (invitations|requests)/i
    .test(extractApiErrorDetail(err.body));
};

const isAlreadyConnectedError = (err: unknown): boolean =>
  err instanceof UnsuccessfulRequestError
  && /already (connected|a connection|in your network)|ALREADY_CONNECTED|is a 1st[- ]degree/i.test(extractApiErrorDetail(err.body));

/** A Connection row for this person on this account, or a resolved profile saying 1st degree. */
const isAlreadyConnected = async (
  lead: { leadData: unknown },
  providerId: string,
  accountId: string,
): Promise<boolean> => {
  const distance = (lead.leadData as { network_distance?: unknown } | null)?.network_distance;
  if (distance === "FIRST_DEGREE" || distance === "DISTANCE_1") return true;
  const [row] = await db.select({ id: connections.id }).from(connections).where(and(
    inOrg(connections),
    eq(connections.providerId, providerId),
    eq(connections.linkedinAccountId, accountId),
  )).limit(1);
  return Boolean(row);
};

/** Drop the unsent invitation claim and attach the lead to its (new or existing) Connection. */
const skipInviteForConnection = async (leadId: string, providerId: string, accountId: string, messageId: string) => {
  await db.transaction(async (tx) => {
    await tx.delete(messages).where(and(inOrg(messages), eq(messages.id, messageId), sql`${messages.linkedinMessageId} is null`));
    await tx.insert(connections).values({
      organizationId: currentOrganizationId(),
      providerId,
      linkedinAccountId: accountId,
      leadId,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [connections.providerId, connections.linkedinAccountId],
      set: { leadId, updatedAt: new Date() },
    });
  });
};

export const sendInvitations = async (account: LinkedInAccount): Promise<void> => {
  if (!(await isPlatformConnected("unipile"))) {
    console.log("[sendInvitations] Unipile is not connected — skipping");
    return;
  }

  const rules = await channelRules("linkedin");
  const maxPerDay = account.dailyInviteLimit ?? (account.isPremium ? rules.invitesPerDayPremium : rules.invitesPerDayFree);
  console.log(`[sendInvitations] Processing account ${account.username} (${account.isPremium ? "premium" : "free"}, limit: ${maxPerDay}/day)`);

  const [{ n: sentTodayCount }] = await db
    .select({ n: sqlCount() })
    .from(leads)
    .where(
      and(
        inOrg(leads),
        eq(leads.linkedinAccountId, account.id),
        ne(leads.status, "PENDING"),
        gte(leads.requestSentAt, getTodayStart())
      )
    );

  const remainingToday = maxPerDay - sentTodayCount;
  if (remainingToday <= 0) {
    console.log(`[sendInvitations] Daily cap reached for ${account.username}, skipping`);
    return;
  }

  const sessionSize = Math.min(
    pickInRange(rules.invitesPerRun),
    remainingToday
  );

  // Fetch candidates ordered by campaign age (oldest first), then lead age (oldest first).
  // This guarantees FIFO within each campaign and that older campaigns always get priority.
  // Leads with no campaign sort last (PostgreSQL: NULL sorts after all non-null ASC values).
  // The campaign-age ordering needs the joined Campaign row, so this is a
  // leftJoin (campaignId is nullable) selecting only the lead columns.
  const pendingLeads = (
    await db
      .select({ lead: leads, person: people, company: companies, campaignInvitationMessage: campaigns.invitationMessage })
      .from(leads)
      .innerJoin(people, eq(leads.personId, people.id))
      .leftJoin(companies, eq(people.companyId, companies.id))
      .leftJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(await pendingLeadsSendableByAccount(account.id))
      .orderBy(asc(campaigns.createdAt), asc(leads.createdAt))
      .limit(sessionSize)
  ).map((r) => ({ ...r.lead, invitationMessage: r.campaignInvitationMessage ?? r.lead.invitationMessage, linkedinUrl: r.person.linkedinUrl!, variables: personVariables(r.person, r.company) }));

  if (pendingLeads.length === 0) {
    console.log(`[sendInvitations] No pending leads with resolved profiles for @${account.username}`);
    await logInviteSendDiagnostics(account.username, account.id);
    return;
  }

  console.log(
    `[sendInvitations] Sending up to ${pendingLeads.length} requests (${sentTodayCount}/${maxPerDay} used today)`
  );

  for (const lead of pendingLeads) {
    const personId = lead.personId!; // eligibility + inner join guarantee this
    const providerId = lead.providerId!;
    const invitationMessage = fillTemplate(lead.invitationMessage ?? "", lead.variables);

    if (isInvitationMessageTooLong(invitationMessage)) {
      console.warn(
        `[sendInvitations] Skipping ${lead.linkedinUrl}: invitation message is ${invitationMessageLength(invitationMessage)} characters (max ${MAX_INVITATION_MESSAGE_LENGTH})`
      );
      await db.update(leads).set({ status: "FAILED" }).where(and(inOrg(leads), eq(leads.id, lead.id)));
      continue;
    }

    // Atomically claim the lead before touching Unipile.
    // If another account (in a shared campaign) already claimed it, the
    // conditional UPDATE matches no row and returns [] — skip.
    const claimed = await db.transaction(async (tx) => {
      // Serialize every claim for this sender/person pair, then recheck after
      // acquiring the lock. This closes the cross-campaign same-batch race.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${account.id}:${personId}`}, 0))`);
      const contacted = await tx.select({ id: leads.id }).from(leads).where(and(
        inOrg(leads),
        eq(leads.personId, personId),
        eq(leads.linkedinAccountId, account.id),
        ne(leads.status, "PENDING"),
      )).limit(1);
      if (contacted.length) return null;
      const leadClaim = await tx
        .update(leads)
        .set({ status: "REQUEST_SENT", linkedinAccountId: account.id, requestSentAt: new Date() })
        .where(and(
          inOrg(leads),
          eq(leads.id, lead.id),
          eq(leads.status, "PENDING"),
          exists(db.select({ id: campaigns.id }).from(campaigns).where(and(
            eq(campaigns.id, leads.campaignId),
            eq(campaigns.status, "ACTIVE"),
            isNotNull(campaigns.triggeredAt),
          ))),
        ))
        .returning({ id: leads.id });
      if (!leadClaim.length) return null;
      const [messageClaim] = await tx.insert(messages).values({
        organizationId: currentOrganizationId(),
        type: "INVITATION",
        text: invitationMessage,
        leadId: lead.id,
        seen: true,
      }).onConflictDoNothing().returning({ id: messages.id });
      return { messageId: messageClaim?.id ?? null };
    });

    if (!claimed?.messageId) {
      console.log(`[sendInvitations] Lead ${lead.linkedinUrl} already claimed or requires provider reconciliation, skipping`);
      continue;
    }

    // The claim is local and recoverable; check global DNC at the last safe
    // point before Unipile and remove the unsent claim when contact is barred.
    if (await isPersonDoNotContact(db, personId)) {
      await db.transaction(async (tx) => {
        await tx.delete(messages).where(and(inOrg(messages), eq(messages.id, claimed.messageId!)));
        await tx.update(leads).set({ status: "FAILED" }).where(and(inOrg(leads), eq(leads.id, lead.id)));
      });
      console.warn(`[sendInvitations] ${lead.linkedinUrl} blocked by Person-global DNC`);
      continue;
    }

    // Already a 1st-degree connection: no invitation to send. Link the lead to the connection
    // and leave it REQUEST_SENT — sendFollowUps' missed-acceptance pass sends the acceptance
    // message and the sequence continues from there.
    if (await isAlreadyConnected(lead, providerId, account.id)) {
      await skipInviteForConnection(lead.id, providerId, account.id, claimed.messageId);
      console.log(`[sendInvitations] ${lead.linkedinUrl} is already a connection — skipping the invitation, messaging instead`);
      continue;
    }

    try {
      const linkedinMessageId = await sendConnectionRequest(providerId, invitationMessage, account.linkedinId);
      if (!linkedinMessageId) {
        throw new Error("Unipile accepted the invitation without returning an invitation_id");
      }

      await db.update(messages).set({ linkedinMessageId }).where(and(inOrg(messages), eq(messages.id, claimed.messageId)));

      await resetLeadRetryCount(lead.id);

      console.log(`[sendInvitations] Request sent to ${lead.linkedinUrl} (${providerId})`);

      const delay = pickInRange(rules.inviteDelaySeconds) * 1000;
      await sleep(delay);
    } catch (err) {
      if (isAlreadyConnectedError(err)) {
        await skipInviteForConnection(lead.id, providerId, account.id, claimed.messageId);
        console.log(`[sendInvitations] LinkedIn says ${lead.linkedinUrl} is already a connection — messaging instead`);
        continue;
      }
      if (isAccountLimitError(err)) {
        console.warn(`[sendInvitations] Account limit reached for ${account.username} — pausing for today: ${serializeError(err)}`);
        // Revert the claim so the lead can be picked up by another account or next day
        await db
          .update(leads)
          .set({ status: "PENDING", linkedinAccountId: null, requestSentAt: null })
          .where(and(inOrg(leads), eq(leads.id, lead.id)));
        await db.delete(messages).where(and(
          inOrg(messages),
          eq(messages.id, claimed.messageId),
          sql`${messages.linkedinMessageId} is null`,
        ));
        await db
          .update(linkedInAccounts)
          .set({ limitReached: true })
          .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.id, account.id)));
        break;
      } else {
        console.error(`[sendInvitations] Failed for ${lead.linkedinUrl}: ${serializeError(err)}`);
        // The provider may have accepted the invitation before the transport
        // failed. Keep both Lead and Message claims so no automated retry can
        // create a duplicate; an operator must reconcile this provider state.
      }
    }
  }
};
