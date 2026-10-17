import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { withLinkedinOrg } from "@/lib/linkedin/organizations.server";
import { db } from "@/lib/db";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { campaignAccounts, campaigns, linkedInAccounts } from "@/lib/linkedin/schema";
import { runOutreach } from "@/jobs/runOutreach";
import { claimCampaignTrigger } from "@/lib/linkedin/campaignTrigger.server";
import { withJobTracking } from "@/lib/linkedin/jobTracker";
import { channelRules } from "@/lib/channels/rules.server";
import { formatWorkingHoursSummary, isWithinWorkingHours, withOrganizationHours } from "@/lib/linkedin/workingHours";
import { serializeError } from "@/lib/linkedin/serializeError";

// POST /api/linkedin/campaigns/:id/send-now — Campaign → Send now. Runs
// outreach at once instead of waiting for the next scheduled run: it skips the
// rest between runs for this campaign's senders, but still keeps their working
// hours and daily limits, which protect the LinkedIn account.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withLinkedinOrg(_req, async () => {
    const { id } = await params;
    try {
      const [campaign] = await db.select({ status: campaigns.status }).from(campaigns).where(and(inOrg(campaigns), eq(campaigns.id, id))).limit(1);
      if (!campaign) return NextResponse.json({ ok: false, error: "Campaign not found" }, { status: 404 });
      if (campaign.status !== "ACTIVE") return NextResponse.json({ ok: false, error: "Launch the campaign first" }, { status: 400 });

      const senderIds = (await db.select({ id: campaignAccounts.linkedinAccountId }).from(campaignAccounts).where(eq(campaignAccounts.campaignId, id))).map((r) => r.id);
      if (senderIds.length === 0) return NextResponse.json({ ok: false, error: "This campaign has no LinkedIn sender" }, { status: 400 });
      const senders = await db.select().from(linkedInAccounts).where(and(inOrg(linkedInAccounts), inArray(linkedInAccounts.id, senderIds)));

      const rules = await channelRules("linkedin");
      const working = senders.filter((s) => isWithinWorkingHours(withOrganizationHours(s, rules.workingHours)));
      if (working.length === 0) {
        const hours = formatWorkingHoursSummary(withOrganizationHours(senders[0], rules.workingHours));
        return NextResponse.json({ ok: false, error: `Outside working hours (${hours}). It sends automatically at the next working time.` }, { status: 409 });
      }

      // Starts the campaign now if it has not triggered yet (atomic; a lost
      // race just means the trigger job got there first). Already triggered:
      // this only runs the next batch early.
      await claimCampaignTrigger(id, true);
      await db.update(linkedInAccounts).set({ nextAllowedRun: null }).where(and(inOrg(linkedInAccounts), inArray(linkedInAccounts.id, working.map((s) => s.id))));
      const runId = await withJobTracking("run-outreach", () => runOutreach({ organizationId: currentOrganizationId() }));
      return NextResponse.json({ ok: true, runId });
    } catch (err) {
      return NextResponse.json({ ok: false, error: serializeError(err) }, { status: 500 });
    }
  });
}
