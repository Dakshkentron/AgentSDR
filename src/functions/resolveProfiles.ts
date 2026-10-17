import { isPlatformConnected } from "@/lib/platform/credentials";
import { inOrg } from "@/lib/tenancy/scope";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { enrichPersonById, withLeadTransaction } from "@/lib/leads/records";
import { campaigns, leads as leadsTable } from "@/lib/linkedin/schema";
import { getProfile } from "@/services/unipile.service";
import type { LinkedInAccount } from "@/lib/linkedin/schema";
import { serializeError } from "@/lib/linkedin/serializeError";
import { claimLeadForResolution, recordResolveFailure } from "@/lib/linkedin/inviteRetry.server";
import { pendingLeadsResolvableByAccount } from "@/lib/linkedin/leadOutreachEligibility";
import { collapseDuplicateCampaignLead } from "@/lib/linkedin/searchIdentity.server";
import { normalizeLinkedinApiHint, publicSlugFromSourceIdentifier } from "@/lib/leads/identity";
import { channelRules } from "@/lib/channels/rules.server";
import { pickInRange } from "@/lib/channels/rules";

// Profiles per run come from Settings → LinkedIn → Sending rules.

export const resolveProfiles = async (
  account: LinkedInAccount,
  options: { activeCampaignsOnly?: boolean; leadId?: string } = {},
): Promise<void> => {
  if (!(await isPlatformConnected("unipile"))) {
    console.log("[resolveProfiles] Unipile is not connected — skipping");
    return;
  }

  const sessionSize = pickInRange((await channelRules("linkedin")).profileLookupsPerRun);
  console.log(`[resolveProfiles] Resolving up to ${sessionSize} profiles via @${account.username}`);

  const baseWhere = await pendingLeadsResolvableByAccount(account.id);

  // Ordering by campaign age needs the joined Campaign row; leftJoin because
  // campaignId is nullable and those leads must still be returned (they sort
  // last — NULL sorts after non-null values in ASC).
  const pendingLeads = (
    await db
      .select({ lead: leadsTable, person: people, company: companies })
      .from(leadsTable)
      .innerJoin(people, eq(leadsTable.personId, people.id))
      .leftJoin(companies, eq(people.companyId, companies.id))
      .leftJoin(campaigns, eq(leadsTable.campaignId, campaigns.id))
      .where(and(
        baseWhere,
        options.activeCampaignsOnly ? eq(campaigns.status, "ACTIVE") : undefined,
        options.leadId ? eq(leadsTable.id, options.leadId) : undefined,
      ))
      .orderBy(asc(campaigns.createdAt), asc(leadsTable.createdAt))
      .limit(sessionSize)
  ).map((r) => ({ ...r.lead, person: r.person, company: r.company }));

  if (pendingLeads.length === 0) {
    console.log(`[resolveProfiles] No unresolved leads eligible for @${account.username}`);
    return;
  }

  console.log(`[resolveProfiles] Resolving ${pendingLeads.length} lead(s) for @${account.username}`);

  let resolved = 0;
  let failed = 0;

  for (const lead of pendingLeads) {
    const sourceIdentifier = lead.sourceLinkedinIdentifier!;
    if (!(await claimLeadForResolution(lead.id))) {
      console.log(`[resolveProfiles] ${sourceIdentifier} already leased by another resolver — skipping`);
      continue;
    }
    try {
      const profile = await getProfile(
        sourceIdentifier,
        account.linkedinId,
        normalizeLinkedinApiHint(lead.sourceLinkedinApi),
        true,
      );
      // Unipile omits public_identifier for members who hide their public
      // profile. When the identifier we searched with is already a canonical
      // slug it is the same value Unipile would have returned, so prefer it
      // over failing the lead; an opaque member URN yields nothing and fails.
      const publicIdentifier = profile.publicIdentifier ?? publicSlugFromSourceIdentifier(sourceIdentifier);
      if (!publicIdentifier) {
        throw new Error("Unipile returned no canonical public LinkedIn identifier");
      }

      const profileExtras = { ...profile.leadData };
      for (const mappedKey of [
        "provider_id",
        "user_provider_id",
        "public_identifier",
        "public_profile_url",
        "first_name",
        "last_name",
        "headline",
        "profile_picture_url",
        "location",
      ]) {
        delete profileExtras[mappedKey];
      }

      const resolvedFirstName = profile.firstName?.trim() || null;
      const resolvedLastName = profile.lastName?.trim() || null;
      const resolvedFullName = [resolvedFirstName, resolvedLastName].filter(Boolean).join(" ") || null;

      await withLeadTransaction(async (tx) => {
        const person = await enrichPersonById(tx, lead.personId, {
          email: lead.person.email ?? profile.email,
          linkedinUrl: publicIdentifier,
          firstName: resolvedFirstName,
          lastName: resolvedLastName,
          fullName: resolvedFullName,
          title: profile.currentTitle ?? profile.headline,
          profilePictureUrl: profile.profilePictureUrl,
          company: lead.company
            ? { domain: lead.company.domain, name: profile.currentCompanyName ?? lead.company.name }
            : profile.currentCompanyName
              ? { name: profile.currentCompanyName }
              : null,
          raw: {
            ...(lead.person.raw ?? {}),
            ...profileExtras,
            ...(profile.location ? { location: profile.location } : {}),
          },
          source: `enrichment:linkedin-profile:${lead.id}`,
        }, { replaceNames: Boolean(resolvedFullName) });

        if (await collapseDuplicateCampaignLead(tx, lead, person.id)) return;
        await tx
          .update(leadsTable)
          .set({
            personId: person.id,
            providerId: profile.providerId,
            linkedinUrl: publicIdentifier,
            name: resolvedFullName ?? lead.name,
            headline: profile.headline.trim() || lead.headline,
            location: profile.location ?? lead.location,
            profilePictureUrl: profile.profilePictureUrl ?? lead.profilePictureUrl,
            leadData: { ...((lead.leadData as Record<string, unknown> | null) ?? {}), ...profile.leadData },
            sourceLinkedinIdentifier: null,
            sourceLinkedinApi: null,
            resolveRetryCount: 0,
            resolveNextAttemptAt: null,
            resolveLastError: null,
          })
          .where(and(inOrg(leadsTable), eq(leadsTable.id, lead.id)));
      });

      console.log(`[resolveProfiles] ${sourceIdentifier} → ${publicIdentifier} (${profile.providerId})`);
      resolved++;
    } catch (err) {
      console.error(`[resolveProfiles] Failed for ${sourceIdentifier}: ${serializeError(err)}`);
      await recordResolveFailure(lead.id, serializeError(err));
      failed++;
    }
  }

  console.log(`[resolveProfiles] Done — resolved: ${resolved}, failed: ${failed}`);
};
