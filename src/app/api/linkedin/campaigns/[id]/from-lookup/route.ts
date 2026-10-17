import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { withLinkedinOrg } from "@/lib/linkedin/organizations.server";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { campaigns, campaignAccounts, linkedInAccounts } from "@/lib/linkedin/schema";
import { getProfile } from "@/services/unipile.service";
import { importLeadRows, mapSpreadsheetRowsWithMapping, suggestedLinkedinMapping } from "@/lib/linkedin/importLeads";
import { buildImportLeadsJsonResponse } from "@/lib/linkedin/importLeadsResponse";
import { serializeError } from "@/lib/linkedin/serializeError";

type LiveRow = { linkedinUrl: string; sourceLinkedinApi?: string | null; name?: string | null; headline?: string | null; location?: string | null };

/**
 * POST /api/linkedin/campaigns/:id/from-lookup — adds leads AgentSDR hasn't
 * seen before, without a saved search batch: either `{ url }` (a single
 * pasted profile link, resolved live via getProfile) or `{ rows }` (already
 * fetched from a live name search — see /api/linkedin/search/live).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withLinkedinOrg(req, async () => {
    const { id: campaignId } = await params;
    try {
      const body = await req.json().catch(() => null);
      const url = typeof body?.url === "string" ? body.url.trim() : null;
      const rows = Array.isArray(body?.rows) ? (body.rows as LiveRow[]) : null;
      if (!url && !rows?.length) return NextResponse.json({ ok: false, error: "url or rows required" }, { status: 400 });

      const [campaign] = await db.select({ id: campaigns.id }).from(campaigns).where(and(inOrg(campaigns), eq(campaigns.id, campaignId))).limit(1);
      if (!campaign) return NextResponse.json({ ok: false, error: "Campaign not found" }, { status: 404 });

      let sheetRows: Record<string, string>[];

      if (url) {
        // Prefer a sender already assigned to this campaign, but a campaign mid-setup
        // (like one still on "Add leads") may have none yet — any connected account
        // in the org can resolve a profile lookup just as well. One profile view is
        // not a search, so the daily search-leads quota doesn't gate it (the same
        // as resolveProfiles, which opens profiles without touching that counter).
        const campaignSenders = await db
          .select({ account: linkedInAccounts })
          .from(campaignAccounts)
          .innerJoin(linkedInAccounts, eq(linkedInAccounts.id, campaignAccounts.linkedinAccountId))
          .where(and(eq(campaignAccounts.campaignId, campaignId), eq(linkedInAccounts.status, "CONNECTED")));
        const [account] = campaignSenders.length > 0
          ? campaignSenders.map((s) => s.account)
          : await db.select().from(linkedInAccounts).where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.status, "CONNECTED")));
        if (!account) {
          return NextResponse.json({ ok: false, error: "No connected LinkedIn account — connect one in Settings → LinkedIn" }, { status: 409 });
        }

        let profile;
        try {
          profile = await getProfile(url, account.linkedinId);
        } catch (err) {
          return NextResponse.json({ ok: false, error: `Could not find that LinkedIn profile: ${serializeError(err)}` }, { status: 400 });
        }

        sheetRows = [{
          "LinkedIn URL": profile.publicIdentifier ?? profile.providerId,
          Name: [profile.firstName, profile.lastName].filter(Boolean).join(" "),
          Headline: profile.headline ?? "",
          Location: profile.location ?? "",
        }];
      } else {
        sheetRows = rows!
          .filter((r) => r.linkedinUrl)
          .map((r) => ({
            "LinkedIn URL": r.linkedinUrl,
            "LinkedIn API": r.sourceLinkedinApi ?? "",
            Name: r.name ?? "",
            Headline: r.headline ?? "",
            Location: r.location ?? "",
          }));
      }

      if (sheetRows.length === 0) return NextResponse.json({ ok: false, error: "Nothing to add" }, { status: 400 });

      const result = await importLeadRows(mapSpreadsheetRowsWithMapping(sheetRows, suggestedLinkedinMapping(Object.keys(sheetRows[0]))), {
        campaignId,
        attachCampaignToExisting: true,
        filename: url ? `LinkedIn profile: ${url}` : "LinkedIn live search",
      });
      return NextResponse.json(buildImportLeadsJsonResponse(result));
    } catch (err) {
      return NextResponse.json({ ok: false, error: serializeError(err) }, { status: 500 });
    }
  });
}
