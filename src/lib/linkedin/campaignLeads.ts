import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { personProfile } from "@/lib/leads/variables";
import { campaigns, leads, linkedInAccounts } from "@/lib/linkedin/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { buildLeadWhere, type LeadListFilters } from "@/lib/linkedin/leadListFilters";

export const CAMPAIGN_LEADS_PAGE_SIZE = 20;

/** Lead columns the campaign list needs (the joined account is selected separately). */
export const campaignLeadListSelect = {
  id: leads.id,
  personId: leads.personId,
  sourceLinkedinIdentifier: leads.sourceLinkedinIdentifier,
  providerId: leads.providerId,
  name: leads.name,
  headline: leads.headline,
  location: leads.location,
  profilePictureUrl: leads.profilePictureUrl,
  status: leads.status,
  requestSentAt: leads.requestSentAt,
  invitationMessage: leads.invitationMessage,
  acceptanceMessage: leads.acceptanceMessage,
  followUp1Message: leads.followUp1Message,
  followUp1SentAt: leads.followUp1SentAt,
  followUp2Message: leads.followUp2Message,
  followUp2SentAt: leads.followUp2SentAt,
  followUp3Message: leads.followUp3Message,
  followUp3SentAt: leads.followUp3SentAt,
  linkedinAccountId: leads.linkedinAccountId,
  createdAt: leads.createdAt,
} as const;

type CampaignLeadRow = {
  id: string;
  personId: string | null;
  sourceLinkedinIdentifier: string | null;
  providerId?: string | null;
  name: string | null;
  headline: string | null;
  location: string | null;
  profilePictureUrl: string | null;
  person: typeof people.$inferSelect | null;
  company: typeof companies.$inferSelect | null;
  status: string;
  requestSentAt: Date | null;
  invitationMessage: string | null;
  acceptanceMessage: string | null;
  followUp1Message: string | null;
  followUp1SentAt: Date | null;
  followUp2Message: string | null;
  followUp2SentAt: Date | null;
  followUp3Message: string | null;
  followUp3SentAt: Date | null;
  linkedinAccountId: string | null;
  linkedInAccount: {
    id: string;
    username: string;
    name: string | null;
    profilePictureUrl: string | null;
  } | null;
  createdAt: Date;
};

export const mapCampaignLeadForClient = (
  l: CampaignLeadRow,
  alsoInCampaigns: { id: string; name: string }[] = []
) => ({
  id: l.id,
  ...(l.person ? personProfile(l.person, l.company) : {
    email: null,
    linkedinUrl: l.sourceLinkedinIdentifier ?? "",
    firstName: null,
    lastName: null,
    name: l.name,
    headline: l.headline,
    location: l.location,
    profilePictureUrl: l.profilePictureUrl,
    company: null,
    variables: {},
  }),
  // Public slug first; until a profile lookup finds it, the member id from the
  // search links to the same profile (linkedinProfileUrl accepts both).
  linkedinUrl: l.person?.linkedinUrl || l.providerId || l.sourceLinkedinIdentifier || "",
  status: l.status,
  requestSentAt: l.requestSentAt?.toISOString() ?? null,
  invitationMessage: l.invitationMessage,
  acceptanceMessage: l.acceptanceMessage,
  followUp1Message: l.followUp1Message,
  followUp1SentAt: l.followUp1SentAt?.toISOString() ?? null,
  followUp2Message: l.followUp2Message,
  followUp2SentAt: l.followUp2SentAt?.toISOString() ?? null,
  followUp3Message: l.followUp3Message,
  followUp3SentAt: l.followUp3SentAt?.toISOString() ?? null,
  linkedinAccountId: l.linkedinAccountId,
  linkedInAccount: l.linkedInAccount,
  createdAt: l.createdAt.toISOString(),
  alsoInCampaigns,
});

/** Other campaigns each canonical person also participates in. */
const findAlsoInCampaigns = async (
  personIds: string[],
  excludeCampaignId: string
): Promise<Map<string, { id: string; name: string }[]>> => {
  const map = new Map<string, { id: string; name: string }[]>();
  if (personIds.length === 0) return map;

  const siblings = await db
    .select({
      personId: leads.personId,
      campaign: { id: campaigns.id, name: campaigns.name },
    })
    .from(leads)
    .leftJoin(campaigns, eq(leads.campaignId, campaigns.id))
    .where(
      and(
        inOrg(leads),
        inArray(leads.personId, personIds),
        // Prisma's `{ not: excludeCampaignId }` on a nullable column also keeps
        // rows where campaignId IS NULL, which a bare `<>` would drop.
        sql`${leads.campaignId} IS DISTINCT FROM ${excludeCampaignId}`
      )
    );

  for (const s of siblings) {
    if (!s.campaign || !s.personId) continue;
    const list = map.get(s.personId) ?? [];
    if (!list.some((c) => c.id === s.campaign!.id)) list.push(s.campaign);
    map.set(s.personId, list);
  }
  return map;
};

export const listCampaignLeadsPage = async (
  campaignId: string,
  page: number,
  filters: Omit<LeadListFilters, "campaignId"> = {},
  limit = CAMPAIGN_LEADS_PAGE_SIZE
) => {
  const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : CAMPAIGN_LEADS_PAGE_SIZE;
  const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  const where = buildLeadWhere({ ...filters, campaignId });
  const [{ n: total }] = await db.select({ n: count() }).from(leads).where(where);
  const pages = Math.max(1, Math.ceil(total / safeLimit));
  const resolvedPage = Math.min(safePage, pages);
  const skip = (resolvedPage - 1) * safeLimit;
  const [campaignMessages] = await db.select({
    invitationMessage: campaigns.invitationMessage,
    acceptanceMessage: campaigns.acceptanceMessage,
    followUp1Message: campaigns.followUp1Message,
    followUp2Message: campaigns.followUp2Message,
    followUp3Message: campaigns.followUp3Message,
  }).from(campaigns).where(and(inOrg(campaigns), eq(campaigns.id, campaignId))).limit(1);

  const rows = await db
    .select({
      ...campaignLeadListSelect,
      person: people,
      company: companies,
      linkedInAccount: {
        id: linkedInAccounts.id,
        username: linkedInAccounts.username,
        name: linkedInAccounts.name,
        profilePictureUrl: linkedInAccounts.profilePictureUrl,
      },
    })
    .from(leads)
    .leftJoin(people, eq(leads.personId, people.id))
    .leftJoin(companies, eq(people.companyId, companies.id))
    .leftJoin(linkedInAccounts, eq(leads.linkedinAccountId, linkedInAccounts.id))
    .where(where)
    .orderBy(desc(leads.updatedAt))
    .offset(skip)
    .limit(safeLimit);

  const alsoInByUrl = await findAlsoInCampaigns(
    rows.flatMap((r) => r.personId ? [r.personId] : []),
    campaignId
  );

  return {
    leads: rows.map((r) => mapCampaignLeadForClient({
      ...r,
      invitationMessage: campaignMessages?.invitationMessage ?? r.invitationMessage,
      acceptanceMessage: campaignMessages?.acceptanceMessage ?? r.acceptanceMessage,
      followUp1Message: campaignMessages?.followUp1Message ?? r.followUp1Message,
      followUp2Message: campaignMessages?.followUp2Message ?? r.followUp2Message,
      followUp3Message: campaignMessages?.followUp3Message ?? r.followUp3Message,
    }, r.personId ? alsoInByUrl.get(r.personId) ?? [] : [])),
    pagination: {
      page: resolvedPage,
      limit: safeLimit,
      total,
      pages,
    },
  };
};
