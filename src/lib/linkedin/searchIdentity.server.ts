/**
 * Search results and profile lookups already carry a person's member id and
 * public slug. Persisting them when a lead is added makes it linkable and
 * invitable at once, instead of spending a profile lookup (resolveProfiles)
 * to rediscover what the search returned.
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { enrichPersonById, withLeadTransaction, type LeadExecutor } from "@/lib/leads/records";
import { inferLinkedinApi, isLinkedinMemberId, normalizeLinkedinApiHint, publicSlugFromSourceIdentifier } from "@/lib/leads/identity";
import { connections, leads, messages } from "@/lib/linkedin/schema";
import { inOrg } from "@/lib/tenancy/scope";

export type KnownLinkedinIdentity = {
  /** The identifier the lead was imported with (Lead.sourceLinkedinIdentifier). */
  source: string;
  sourceApi?: string | null;
  providerId?: string | null;
  publicIdentifier?: string | null;
  networkDistance?: string | null;
};

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Identity fields out of a raw Unipile/Leopile search item or profile. */
export function identityFromRaw(source: string, sourceApi: string | null, raw: unknown, networkDistance?: string | null): KnownLinkedinIdentity {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    source,
    sourceApi,
    providerId: str(r.provider_id) ?? str(r.id),
    publicIdentifier: str(r.public_identifier) ?? str(r.public_profile_url),
    networkDistance: networkDistance ?? str(r.network_distance),
  };
}

/**
 * Collapse `leadId` into an existing Lead of the same person in the same
 * campaign. Returns true when it was deleted (the caller must stop). Throws
 * when the lead already has history, which must not be lost silently.
 */
export async function collapseDuplicateCampaignLead(
  tx: LeadExecutor,
  lead: { id: string; campaignId: string | null },
  personId: string,
): Promise<boolean> {
  if (!lead.campaignId) return false;
  const [duplicate] = await tx.select({ id: leads.id }).from(leads).where(and(
    inOrg(leads),
    eq(leads.personId, personId),
    eq(leads.campaignId, lead.campaignId),
    ne(leads.id, lead.id),
  )).limit(1);
  if (!duplicate) return false;
  const [message] = await tx.select({ id: messages.id }).from(messages).where(and(inOrg(messages), eq(messages.leadId, lead.id))).limit(1);
  const [connection] = await tx.select({ id: connections.id }).from(connections).where(and(inOrg(connections), eq(connections.leadId, lead.id))).limit(1);
  if (message || connection) {
    throw new Error(`Cannot collapse duplicate campaign Lead ${lead.id}: it already has message or connection history`);
  }
  await tx.delete(leads).where(and(inOrg(leads), eq(leads.id, lead.id)));
  return true;
}

/**
 * For each identity, the campaign's still-unresolved PENDING lead imported with
 * that source: store network_distance, and with a member id + public slug mark
 * it resolved exactly as resolveProfiles would. Only a member id: store it as
 * providerId (links work) and leave the lead for resolveProfiles to find the slug.
 * Sales Navigator / Recruiter ids are not provider ids — left to resolveProfiles.
 * Best effort per lead: a conflict leaves the lead for the normal lookup.
 */
export async function applyKnownLinkedinIdentities(campaignId: string, items: KnownLinkedinIdentity[]): Promise<number> {
  let resolved = 0;
  for (const item of items) {
    const api = normalizeLinkedinApiHint(item.sourceApi) ?? inferLinkedinApi(item.source);
    const providerId = !api
      ? [item.providerId, item.source].find((v) => isLinkedinMemberId(v)) ?? null
      : null;
    const slug = publicSlugFromSourceIdentifier(item.publicIdentifier) ?? publicSlugFromSourceIdentifier(item.source);
    const distance = item.networkDistance ?? null;
    if (!providerId && !distance) continue;
    try {
      await withLeadTransaction(async (tx) => {
        const [lead] = await tx.select({ id: leads.id, personId: leads.personId, campaignId: leads.campaignId, leadData: leads.leadData })
          .from(leads)
          .where(and(
            inOrg(leads),
            eq(leads.campaignId, campaignId),
            eq(leads.status, "PENDING"),
            isNull(leads.providerId),
            sql`lower(${leads.sourceLinkedinIdentifier}) = lower(${item.source})`,
          ))
          .limit(1);
        if (!lead) return;
        const leadData = { ...((lead.leadData as Record<string, unknown> | null) ?? {}), ...(distance ? { network_distance: distance } : {}) };
        if (!providerId) {
          await tx.update(leads).set({ leadData }).where(and(inOrg(leads), eq(leads.id, lead.id)));
          return;
        }
        if (!slug) {
          await tx.update(leads).set({ providerId, leadData }).where(and(inOrg(leads), eq(leads.id, lead.id)));
          return;
        }
        const person = await enrichPersonById(tx, lead.personId, { linkedinUrl: slug, source: `campaign:linkedin:${campaignId}` });
        if (await collapseDuplicateCampaignLead(tx, lead, person.id)) return;
        await tx.update(leads).set({
          personId: person.id,
          providerId,
          linkedinUrl: slug,
          leadData,
          sourceLinkedinIdentifier: null,
          sourceLinkedinApi: null,
          resolveRetryCount: 0,
          resolveNextAttemptAt: null,
          resolveLastError: null,
        }).where(and(inOrg(leads), eq(leads.id, lead.id)));
        resolved++;
      });
    } catch (err) {
      console.warn(`[applyKnownLinkedinIdentities] ${item.source} left for profile lookup: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return resolved;
}
