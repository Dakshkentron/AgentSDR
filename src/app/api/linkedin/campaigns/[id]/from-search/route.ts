import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { withLinkedinOrg } from "@/lib/linkedin/organizations.server";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { campaigns, searchBatches, searchQueries, searchResults } from "@/lib/linkedin/schema";
import { importLeadRows, mapSpreadsheetRowsWithMapping, suggestedLinkedinMapping } from "@/lib/linkedin/importLeads";
import { buildImportLeadsJsonResponse } from "@/lib/linkedin/importLeadsResponse";
import { serializeError } from "@/lib/linkedin/serializeError";
import { applyKnownLinkedinIdentities, identityFromRaw } from "@/lib/linkedin/searchIdentity.server";

// POST /api/linkedin/campaigns/:id/from-search { batchId } — adds everyone a
// LinkedIn search found to the campaign. Same rows and import path as the
// search's Export leads file uploaded through the campaign's spreadsheet import.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withLinkedinOrg(req, async () => {
    const { id: campaignId } = await params;
    try {
      const body = await req.json().catch(() => null);
      const batchId = typeof body?.batchId === "string" ? body.batchId : null;
      if (!batchId) return NextResponse.json({ ok: false, error: "batchId required" }, { status: 400 });

      const [campaign] = await db.select({ id: campaigns.id }).from(campaigns).where(and(inOrg(campaigns), eq(campaigns.id, campaignId))).limit(1);
      if (!campaign) return NextResponse.json({ ok: false, error: "Campaign not found" }, { status: 404 });
      const [batch] = await db.select({ name: searchBatches.name }).from(searchBatches).where(and(inOrg(searchBatches), eq(searchBatches.id, batchId))).limit(1);
      if (!batch) return NextResponse.json({ ok: false, error: "Search not found" }, { status: 404 });

      const found = await db
        .select({ result: searchResults, companyName: searchQueries.companyName })
        .from(searchResults)
        .innerJoin(searchQueries, eq(searchResults.searchQueryId, searchQueries.id))
        .where(inArray(searchQueries.batchId, [batchId]))
        .orderBy(asc(searchResults.createdAt));
      const seen = new Set<string>();
      const unique = found.filter(({ result }) => !seen.has(result.linkedinUrl) && seen.add(result.linkedinUrl));
      const rows = unique
        .map(({ result, companyName }) => ({
          "Company Name": companyName ?? "",
          "LinkedIn URL": result.linkedinUrl,
          "LinkedIn API": result.sourceLinkedinApi ?? "",
          Name: result.name ?? "",
          Headline: result.headline ?? "",
          Location: result.location ?? "",
        }));
      if (rows.length === 0) return NextResponse.json({ ok: false, error: "This search has not found anyone yet — run it first" }, { status: 400 });

      const result = await importLeadRows(mapSpreadsheetRowsWithMapping(rows, suggestedLinkedinMapping(Object.keys(rows[0]))), {
        campaignId,
        attachCampaignToExisting: true,
        filename: `LinkedIn search: ${batch.name}`,
      });
      await applyKnownLinkedinIdentities(campaignId, unique.map(({ result }) =>
        identityFromRaw(result.linkedinUrl, result.sourceLinkedinApi, result.raw, result.networkDistance)));
      return NextResponse.json(buildImportLeadsJsonResponse(result));
    } catch (err) {
      return NextResponse.json({ ok: false, error: serializeError(err) }, { status: 500 });
    }
  });
}
