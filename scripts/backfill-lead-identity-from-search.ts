/**
 * Gives unresolved LinkedIn campaign leads the identity their search already
 * returned, so they link and invite without a profile lookup.
 *
 *   bun run --conditions=react-server scripts/backfill-lead-identity-from-search.ts          # report only
 *   bun run --conditions=react-server scripts/backfill-lead-identity-from-search.ts --apply  # write
 *
 * Targets PENDING leads with no providerId and a sourceLinkedinIdentifier. The
 * raw search item is read from "SearchResult".raw (matched on the same
 * identifier, through this organization's SearchBatch), then applied by
 * applyKnownLinkedinIdentities — the same code the add paths use: member id +
 * public slug marks the lead resolved (people.linkedin_url = slug), a member id
 * alone is stored as providerId, network_distance lands in leadData.
 *
 * Re-runnable: a lead it resolved no longer matches. Runs in ORGANIZATION_ID,
 * or the initial organization when it is unset.
 */
import { runScriptInOrganization } from "./lib/organization";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { leads, searchBatches, searchQueries, searchResults } from "@/lib/linkedin/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { applyKnownLinkedinIdentities, identityFromRaw, type KnownLinkedinIdentity } from "@/lib/linkedin/searchIdentity.server";

const apply = process.argv.includes("--apply");

async function main() {
  const pending = await db
    .select({ campaignId: leads.campaignId, source: leads.sourceLinkedinIdentifier, sourceApi: leads.sourceLinkedinApi })
    .from(leads)
    .where(and(inOrg(leads), eq(leads.status, "PENDING"), isNull(leads.providerId), isNotNull(leads.sourceLinkedinIdentifier), isNotNull(leads.campaignId)));
  console.log(`${pending.length} unresolved PENDING campaign lead(s)`);

  const byCampaign = new Map<string, KnownLinkedinIdentity[]>();
  let withRaw = 0;
  for (const lead of pending) {
    const [found] = await db
      .select({ raw: searchResults.raw, networkDistance: searchResults.networkDistance })
      .from(searchResults)
      .innerJoin(searchQueries, eq(searchResults.searchQueryId, searchQueries.id))
      .innerJoin(searchBatches, eq(searchQueries.batchId, searchBatches.id))
      .where(and(inOrg(searchBatches), sql`lower(${searchResults.linkedinUrl}) = lower(${lead.source!})`))
      .limit(1);
    if (found) withRaw++;
    // No stored search item: a member-id source still yields a providerId.
    const identity = found
      ? identityFromRaw(lead.source!, lead.sourceApi, found.raw, found.networkDistance)
      : { source: lead.source!, sourceApi: lead.sourceApi };
    const list = byCampaign.get(lead.campaignId!) ?? [];
    list.push(identity);
    byCampaign.set(lead.campaignId!, list);
  }
  console.log(`${withRaw} matched a stored search result`);
  if (!apply) {
    console.log("Report only — rerun with --apply to write.");
    return true;
  }
  let resolved = 0;
  for (const [campaignId, items] of byCampaign) resolved += await applyKnownLinkedinIdentities(campaignId, items);
  console.log(`Resolved ${resolved} lead(s); the rest got whatever partial identity was known and stay for profile lookup.`);
  return true;
}

runScriptInOrganization(main)
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
