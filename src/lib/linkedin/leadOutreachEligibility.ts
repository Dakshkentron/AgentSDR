import { and, eq, exists, isNotNull, isNull, lt, lte, ne, notExists, notInArray, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaignAccounts, campaigns, leads } from "@/lib/linkedin/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { MAX_LEAD_RETRIES } from "./inviteRetry";

/**
 * LinkedIn URLs this account has already contacted (resolved or sent to) under
 * ANY campaign. The same account must never reach the same person twice, even
 * across campaigns — this is the exclusion list for that guard.
 */
const alreadyContactedPeopleByAccount = async (linkedinAccountId: string): Promise<string[]> => {
  const rows = await db
    .selectDistinct({ personId: leads.personId })
    .from(leads)
    .where(and(inOrg(leads), eq(leads.linkedinAccountId, linkedinAccountId), ne(leads.status, "PENDING")));
  return rows.flatMap((r) => r.personId ? [r.personId] : []);
};

/**
 * The campaign half of the eligibility rule, shared by both helpers below:
 * the lead has no campaign at all, or its campaign is ACTIVE and either has no
 * account assignments (open to any sender) or explicitly includes this sender.
 * A campaign is only eligible once triggered ("triggeredAt" set by the
 * linkedin-trigger-campaigns job or Send now), so nothing goes out before its
 * trigger time.
 */
const campaignEligibility = (linkedinAccountId: string): SQL =>
  or(
    isNull(leads.campaignId),
    exists(
      db
        .select({ one: campaigns.id })
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, leads.campaignId),
            eq(campaigns.status, "ACTIVE"),
            isNotNull(campaigns.triggeredAt),
            notExists(
              db
                .select({ one: campaignAccounts.campaignId })
                .from(campaignAccounts)
                .where(eq(campaignAccounts.campaignId, campaigns.id))
            )
          )
        )
    ),
    exists(
      db
        .select({ one: campaigns.id })
        .from(campaigns)
        .where(
          and(
            eq(campaigns.id, leads.campaignId),
            eq(campaigns.status, "ACTIVE"),
            isNotNull(campaigns.triggeredAt),
            exists(
              db
                .select({ one: campaignAccounts.campaignId })
                .from(campaignAccounts)
                .where(
                  and(
                    eq(campaignAccounts.campaignId, campaigns.id),
                    eq(campaignAccounts.linkedinAccountId, linkedinAccountId)
                  )
                )
            )
          )
        )
    )
  )!;


/**
 * True when the campaign's Exclude options bar this person. "Blacklist" is
 * the Person-global Do Not Contact policy (crm_person_contact_policies); a
 * "blacklisted company" is any company with at least one DNC person — there
 * is no company-level blacklist. "Contacted" means a Lead in another campaign
 * past PENDING; "same sender" narrows that to this campaign's senders.
 */
export const excludedByCampaign = (personId: AnyColumn | SQL, campaignId: AnyColumn | SQL | string): SQL => sql`exists (
  select 1 from "Campaign" xc where xc.id = ${campaignId} and xc."organizationId" = ${currentOrganizationId()} and (
    (xc."excludeBlacklisted" and exists (
      select 1 from crm_person_contact_policies xp where xp.person_id = ${personId} and xp.do_not_contact))
    or (xc."excludeBlacklistedCompanies" and exists (
      select 1 from people xa
      join people xb on xb.company_id = xa.company_id and xb.organization_id = xa.organization_id
      join crm_person_contact_policies xp on xp.person_id = xb.id and xp.do_not_contact
      where xa.id = ${personId}))
    or ((xc."excludeContactedOtherCampaigns" or xc."excludeContactedBySameSender") and exists (
      select 1 from "Lead" xl where xl."organizationId" = xc."organizationId" and xl."personId" = ${personId}
        and xl."campaignId" is distinct from xc.id and xl.status <> 'PENDING'
        and (xc."excludeContactedOtherCampaigns" or xl."linkedinAccountId" in (
          select ca."linkedinAccountId" from "CampaignAccount" ca where ca."campaignId" = xc.id))))
  ))`;

/** Leads this sender may invite (campaign assignment + active campaign rules). */
export const pendingLeadsSendableByAccount = async (linkedinAccountId: string): Promise<SQL> => {
  const excludedPeople = await alreadyContactedPeopleByAccount(linkedinAccountId);
  return and(
    inOrg(leads),
    eq(leads.status, "PENDING"),
    lt(leads.inviteRetryCount, MAX_LEAD_RETRIES),
    isNotNull(leads.providerId),
    isNotNull(leads.personId),
    isNull(leads.sourceLinkedinIdentifier),
    ...(excludedPeople.length > 0 ? [notInArray(leads.personId, excludedPeople)] : []),
    campaignEligibility(linkedinAccountId),
    sql`not ${excludedByCampaign(leads.personId, leads.campaignId)}`
  )!;
};

/** Leads this sender may resolve before inviting (same campaign rules, not yet resolved). */
export const pendingLeadsResolvableByAccount = async (linkedinAccountId: string): Promise<SQL> => {
  const excludedPeople = await alreadyContactedPeopleByAccount(linkedinAccountId);
  return and(
    inOrg(leads),
    eq(leads.status, "PENDING"),
    lt(leads.resolveRetryCount, MAX_LEAD_RETRIES),
    isNotNull(leads.sourceLinkedinIdentifier),
    or(isNull(leads.resolveNextAttemptAt), lte(leads.resolveNextAttemptAt, new Date())),
    ...(excludedPeople.length > 0 ? [notInArray(leads.personId, excludedPeople)] : []),
    campaignEligibility(linkedinAccountId),
    sql`not ${excludedByCampaign(leads.personId, leads.campaignId)}`
  )!;
};
