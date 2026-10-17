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
import { getProfile, searchLinkedIn } from "@/services/unipile.service";
import { inferLinkedinApi, normalizeLinkedinSourceIdentifier } from "@/lib/leads/identity";
import { serializeError } from "@/lib/linkedin/serializeError";

type RawItem = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Unipile and Unipile-compatible APIs (Leopile) don't agree on one item shape — take whichever field is present. */
function personName(item: RawItem): string | null {
  return str(item.name) ?? ([str(item.first_name), str(item.last_name)].filter(Boolean).join(" ") || null);
}

function personCompany(item: RawItem): string | null {
  const positions = (item.current_positions ?? item.work_experience) as RawItem[] | undefined;
  const current = Array.isArray(positions) ? positions[0] : undefined;
  return str(current?.company) ?? str(item.company) ?? str(item.company_name);
}

/**
 * POST /api/linkedin/search/live { query, kind? } — a quick, one-page LinkedIn lookup
 * for the "Add from People" modal. `query` is a name/keywords, a LinkedIn search URL,
 * or a profile URL (one profile view, not gated by the search quota). `kind:
 * "companies"` searches companies instead; a company's people are then found by
 * searching again with its `peopleSearchUrl`. Nothing is saved: results are a
 * preview the caller adds via campaigns/:id/from-lookup.
 */
export async function POST(req: NextRequest) {
  return withLinkedinOrg(req, async () => {
    try {
      const body = await req.json().catch(() => null);
      const query = typeof body?.query === "string" ? body.query.trim() : "";
      if (!query) return NextResponse.json({ ok: false, error: "query required" }, { status: 400 });
      const kind = body?.kind === "companies" ? "companies" : "people";

      if (/linkedin\.com\/(in|sales\/lead|sales\/people|talent\/profile)\//i.test(query)) {
        const [account] = await db.select().from(linkedInAccounts).where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.status, "CONNECTED")));
        if (!account) return NextResponse.json({ ok: false, error: "No connected LinkedIn account — connect one in Settings → LinkedIn" }, { status: 409 });
        let profile;
        try {
          profile = await getProfile(query, account.linkedinId);
        } catch (err) {
          return NextResponse.json({ ok: false, error: `Could not find that LinkedIn profile: ${serializeError(err)}` }, { status: 400 });
        }
        const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null;
        return NextResponse.json({
          ok: true,
          results: [{
            linkedinUrl: profile.publicIdentifier ?? profile.providerId,
            providerId: profile.providerId,
            publicIdentifier: profile.publicIdentifier,
            sourceLinkedinApi: inferLinkedinApi(query),
            name,
            headline: profile.headline || profile.currentTitle,
            company: profile.currentCompanyName,
            location: profile.location,
            profilePictureUrl: profile.profilePictureUrl,
            networkDistance: typeof profile.leadData?.network_distance === "string" ? profile.leadData.network_distance : null,
          }],
        });
      }

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

      let url = kind === "companies" && !/^https?:\/\//i.test(query)
        ? `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(query)}`
        : toSearchUrl(query);
      // "My connections": LinkedIn's 1st-degree facet, which Unipile and Leopile both honour.
      if (kind === "people" && body?.connectionsOnly === true) {
        const u = new URL(url);
        u.searchParams.set("network", JSON.stringify(["F"]));
        url = u.toString();
      }
      let result;
      try {
        result = await searchLinkedIn(account.linkedinId, url);
      } catch (err) {
        return NextResponse.json({ ok: false, error: `LinkedIn search failed: ${serializeError(err)}` }, { status: 502 });
      }

      const items = (result.items ?? []) as RawItem[];
      await incrementSearchLeadsToday(account.linkedinId, items.length);

      if (kind === "companies") {
        const companies = items
          .map((item) => {
            const id = str(item.id) ?? (typeof item.id === "number" ? String(item.id) : null);
            if (!id) return null;
            return {
              id,
              name: str(item.name) ?? id,
              industry: str(item.industry),
              location: str(item.location),
              peopleSearchUrl: `https://www.linkedin.com/search/results/people/?currentCompany=${encodeURIComponent(JSON.stringify([id]))}`,
            };
          })
          .filter((c): c is NonNullable<typeof c> => c !== null);
        return NextResponse.json({ ok: true, companies });
      }

      const sourceLinkedinApi = inferLinkedinApi(url);
      const results = items
        .map((item) => {
          const linkedinUrl = normalizeLinkedinSourceIdentifier(
            str(item.id) ?? str(item.profile_url) ?? str(item.public_identifier) ?? str(item.public_profile_url)
          );
          if (!linkedinUrl) return null;
          return {
            linkedinUrl,
            providerId: str(item.provider_id) ?? str(item.id),
            publicIdentifier: str(item.public_identifier),
            sourceLinkedinApi,
            name: personName(item),
            headline: str(item.headline) ?? str(item.occupation) ?? str(item.title),
            company: personCompany(item),
            location: str(item.location),
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
