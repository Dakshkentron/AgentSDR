import "server-only";

import { and, eq, isNull, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { runOutreach } from "@/jobs/runOutreach";
import { campaigns } from "@/lib/linkedin/schema";
import { unipileOrganizationIds } from "@/lib/linkedin/organizations.server";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { serializeError } from "@/lib/linkedin/serializeError";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";

/**
 * Marks a campaign of the current organization triggered, once. The
 * `"triggeredAt" IS NULL` guard makes it atomic: of two instances (or the
 * job and Send now) racing for the same campaign, exactly one gets the row.
 * `immediately` (Send now) also moves "triggerAt" to now.
 */
export async function claimCampaignTrigger(campaignId: string, immediately = false): Promise<boolean> {
  const now = new Date();
  const claimed = await db
    .update(campaigns)
    .set({ triggeredAt: now, ...(immediately && { triggerAt: now }) })
    .where(and(inOrg(campaigns), eq(campaigns.id, campaignId), isNull(campaigns.triggeredAt)))
    .returning({ id: campaigns.id });
  return claimed.length > 0;
}

/**
 * The linkedin-trigger-campaigns job (every minute): every ACTIVE campaign
 * whose "triggerAt" has passed and that has not run yet is claimed, then its
 * organization's outreach runs once. From then on the 30-minute outreach cron
 * picks its leads up (they are gated on "triggeredAt" until now).
 */
export async function triggerDueCampaigns(): Promise<{ triggered: number }> {
  // Claiming while outreach cannot run would hand the campaign to the regular
  // cron unannounced; leave it due until the controls lift.
  if (isMigrationControlPaused("linkedinResolution") && isMigrationControlPaused("linkedinOutbound")) return { triggered: 0 };

  let triggered = 0;
  for (const organizationId of await unipileOrganizationIds()) {
    try {
      const fired = await runInOrganization(organizationId, async () => {
        const due = await db
          .select({ id: campaigns.id })
          .from(campaigns)
          .where(and(inOrg(campaigns), eq(campaigns.status, "ACTIVE"), isNull(campaigns.triggeredAt), lte(campaigns.triggerAt, new Date())));
        let n = 0;
        for (const c of due) if (await claimCampaignTrigger(c.id)) n++;
        return n;
      });
      if (fired > 0) {
        triggered += fired;
        console.log(`[triggerCampaigns] ${fired} campaign(s) triggered in organization ${organizationId}; running outreach`);
        await runOutreach({ organizationId });
      }
    } catch (err) {
      console.error(`[triggerCampaigns] Organization ${organizationId} failed: ${serializeError(err)}`);
    }
  }
  return { triggered };
}
