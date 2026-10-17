import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { withLinkedinOrg } from "@/lib/linkedin/organizations.server";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { campaigns, campaignAccounts, linkedInAccounts } from "@/lib/linkedin/schema";
import { getSearchUsage } from "@/lib/linkedin/searchLeadLimit";
import { incrementSearchLeadsToday } from "@/lib/linkedin/searchLeadLimit.server";
import { channelRules } from "@/lib/channels/rules.server";
import { getProfile } from "@/services/unipile.service";
import { importLeadRows, mapSpreadsheetRowsWithMapping, suggestedLinkedinMapping } from "@/lib/linkedin/importLeads";
import { buildImportLeadsJsonResponse } from "@/lib/linkedin/importLeadsResponse";
import { serializeError } from "@/lib/linkedin/serializeError";

type LiveRow = { linkedinUrl: string; name?: string | null; headline?: string | null; location?: string | null };

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
        const dailyLimit = (await channelRules("linkedin")).searchLeadsPerDay;
        const senders = await db
          .select({ account: linkedInAccounts })
          .from(campaignAccounts)
          .innerJoin(linkedInAccounts, eq(linkedInAccounts.id, campaignAccounts.linkedinAccountId))
          .where(and(eq(campaignAccounts.campaignId, campaignId), eq(linkedInAccounts.status, "CONNECTED")));
        const account = senders.map((s) => s.account).find((a) => !getSearchUsage(a.searchLeadsToday, dailyLimit).limitReached);
        if (!account) return NextResponse.json({ ok: false, error: "No connected sender with search quota left today" }, { status: 409 });

        let profile;
        try {
          profile = await getProfile(url, account.linkedinId);
        } catch (err) {
          return NextResponse.json({ ok: false, error: `Could not resolve that profile: ${serializeError(err)}` }, { status: 400 });
        }
        await incrementSearchLeadsToday(account.linkedinId, 1);

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
