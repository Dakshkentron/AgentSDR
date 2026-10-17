import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { withLinkedinOrg } from "@/lib/linkedin/organizations.server";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import { toSearchUrl } from "@/lib/linkedin/searchBatches";
import { getSearchUsage } from "@/lib/linkedin/searchLeadLimit";
import { incrementSearchLeadsToday } from "@/lib/linkedin/searchLeadLimit.server";
import { channelRules } from "@/lib/channels/rules.server";
import { searchLinkedIn } from "@/services/unipile.service";
import { normalizeLinkedinSourceIdentifier } from "@/lib/leads/identity";
import { serializeError } from "@/lib/linkedin/serializeError";

type RawItem = Record<string, unknown>;

/**
 * POST /api/linkedin/search/live { query } — a quick, one-page LinkedIn name/keyword
 * search for the "Add from People" modal. Not saved as a Search batch: results are
 * handed straight back for the caller to pick from and add via campaigns/:id/from-lookup.
 */
export async function POST(req: NextRequest) {
  return withLinkedinOrg(req, async () => {
    try {
      const body = await req.json().catch(() => null);
      const query = typeof body?.query === "string" ? body.query.trim() : "";
      if (!query) return NextResponse.json({ ok: false, error: "query required" }, { status: 400 });

      const dailyLimit = (await channelRules("linkedin")).searchLeadsPerDay;
      const accounts = await db.select().from(linkedInAccounts).where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.status, "CONNECTED")));
      const account = accounts.find((a) => !getSearchUsage(a.searchLeadsToday, dailyLimit).limitReached);
      if (!account) {
        return NextResponse.json(
          {
            ok: false,
            error: accounts.length === 0
              ? "No connected LinkedIn account — connect one in Settings → LinkedIn"
              : `Today's LinkedIn search limit (${dailyLimit} leads per account) is used up. It resets tomorrow, or raise it in Settings → LinkedIn → Sending rules. Pasting a profile URL still works.`,
          },
          { status: 409 }
        );
      }

      const url = toSearchUrl(query);
      let result;
      try {
        result = await searchLinkedIn(account.linkedinId, url);
      } catch (err) {
        return NextResponse.json({ ok: false, error: `LinkedIn search failed: ${serializeError(err)}` }, { status: 502 });
      }

      const items = (result.items ?? []) as RawItem[];
      await incrementSearchLeadsToday(account.linkedinId, items.length);

      const results = items
        .map((item) => {
          const linkedinUrl = normalizeLinkedinSourceIdentifier(
            (item.id as string) ?? (item.profile_url as string) ?? (item.public_identifier as string) ?? (item.public_profile_url as string)
          );
          if (!linkedinUrl) return null;
          return {
            linkedinUrl,
            name: (item.name as string) ?? null,
            headline: (item.headline as string) ?? null,
            location: (item.location as string) ?? null,
            profilePictureUrl: (item.profile_picture_url as string) ?? null,
            networkDistance: (item.network_distance as string) ?? null,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      return NextResponse.json({ ok: true, results });
    } catch (err) {
      return NextResponse.json({ ok: false, error: serializeError(err) }, { status: 500 });
    }
  });
}
