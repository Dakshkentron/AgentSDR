import { db } from "@/lib/db";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import { syncLinkedinMessages } from "@/lib/linkedin/messages/syncFromUnipile";
import { serializeError } from "@/lib/linkedin/serializeError";
import { runInOrganization } from "@/lib/tenancy/scope";

/**
 * Scheduled catch-up for every organization with a LinkedIn account: pulls
 * chats active in the last day, so a message a webhook missed (app down,
 * webhook not registered yet) still reaches the inbox. One organization
 * failing (Unipile disconnected, …) does not stop the others.
 */
export async function syncLinkedinMessagesForAllOrganizations(): Promise<{ organizations: number; messages: number; failed: number }> {
  const rows = await db.selectDistinct({ organizationId: linkedInAccounts.organizationId }).from(linkedInAccounts);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const summary = { organizations: rows.length, messages: 0, failed: 0 };
  for (const { organizationId } of rows) {
    try {
      const result = await runInOrganization(organizationId, () => syncLinkedinMessages({ since }));
      summary.messages += result.messages;
    } catch (err) {
      summary.failed += 1;
      console.warn(`[sync-linkedin-messages] organization ${organizationId}: ${serializeError(err)}`);
    }
  }
  return summary;
}
