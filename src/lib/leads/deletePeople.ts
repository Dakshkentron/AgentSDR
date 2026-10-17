import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { people } from "./schema";
import { inOrg } from "@/lib/tenancy/scope";
import { outreachCampaigns, outreachLeads } from "@/lib/outreach/schema";
import { campaigns as linkedinCampaigns, connections as linkedinConnections, leads as linkedinLeads, messages as linkedinMessages } from "@/lib/linkedin/schema";
import { callCampaignContacts, callCampaigns, callMessages, callSessions } from "@/lib/calls/schema";
import {
  crmClassifications,
  crmConversationMessages,
  crmConversations,
  crmDraftKnowledgeCitations,
  crmDrafts,
  crmEvents,
  crmIdentityExceptions,
  crmJobs,
  crmPersonContactPolicies,
  crmRecords,
  crmRecordSequenceOverrides,
  crmSendAttempts,
  crmSequenceRuns,
  crmSequenceStepRuns,
} from "@/lib/crm/schema";
import type { LeadExecutor } from "./records";

const BATCH_SIZE = 25;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Delete one batch of Person rows and everything across every subsystem that
 * references them, in dependency order (every reference is `onDelete:
 * "restrict"` at the database level unless noted), inside one transaction.
 *
 * What the database already handles on its own, with no code here: deleting
 * `people` cascades `whatsapp_campaign_leads` (and its `whatsapp_campaign_sends`)
 * and sets `whatsapp_chats.person_id` to null — both declared `onDelete`
 * "cascade" / "set null" in src/lib/whatsapp/schema.ts.
 */
async function deleteBatch(tx: LeadExecutor, requestedIds: string[]): Promise<string[]> {
  // Only ever touch Person rows this organization actually owns.
  const owned = await tx.select({ id: people.id }).from(people).where(and(inOrg(people), inArray(people.id, requestedIds)));
  const ids = owned.map((row) => row.id);
  if (!ids.length) return [];

  // --- LinkedIn: messages and connections first, removing the lead's
  // history entirely rather than leaving it orphaned (same order as the
  // campaign DELETE route in src/app/api/linkedin/campaigns/[id]/route.ts). ---
  const leadRows = await tx
    .select({ id: linkedinLeads.id })
    .from(linkedinLeads)
    .innerJoin(linkedinCampaigns, eq(linkedinLeads.campaignId, linkedinCampaigns.id))
    .where(and(inOrg(linkedinCampaigns), inArray(linkedinLeads.personId, ids)));
  const leadIds = leadRows.map((row) => row.id);
  if (leadIds.length) {
    await tx.delete(linkedinMessages).where(and(inOrg(linkedinMessages), inArray(linkedinMessages.leadId, leadIds)));
    await tx.delete(linkedinConnections).where(and(inOrg(linkedinConnections), inArray(linkedinConnections.leadId, leadIds)));
    await tx.delete(linkedinLeads).where(and(inOrg(linkedinLeads), inArray(linkedinLeads.id, leadIds)));
  }

  // --- Outreach (email): outreach_leads has no organization_id of its own —
  // it is scoped through its campaign. Its own dependents
  // (outreach_mailbox_queue, outreach_emails) cascade automatically. ---
  const outreachLeadRows = await tx
    .select({ id: outreachLeads.id })
    .from(outreachLeads)
    .innerJoin(outreachCampaigns, eq(outreachLeads.campaignId, outreachCampaigns.id))
    .where(and(inOrg(outreachCampaigns), inArray(outreachLeads.personId, ids)));
  const outreachLeadIds = outreachLeadRows.map((row) => row.id);
  if (outreachLeadIds.length) {
    await tx.delete(outreachLeads).where(inArray(outreachLeads.id, outreachLeadIds));
  }

  // --- Calls: call_messages and call_sessions reference personId directly
  // (restrict); call_campaign_contacts is scoped through its campaign. ---
  await tx.delete(callMessages).where(and(inOrg(callMessages), inArray(callMessages.personId, ids)));
  await tx.delete(callSessions).where(and(inOrg(callSessions), inArray(callSessions.personId, ids)));
  const contactRows = await tx
    .select({ id: callCampaignContacts.id })
    .from(callCampaignContacts)
    .innerJoin(callCampaigns, eq(callCampaignContacts.campaignId, callCampaigns.id))
    .where(and(inOrg(callCampaigns), inArray(callCampaignContacts.personId, ids)));
  const contactIds = contactRows.map((row) => row.id);
  if (contactIds.length) {
    await tx.delete(callCampaignContacts).where(inArray(callCampaignContacts.id, contactIds));
  }

  // --- CRM: a deep, all-"restrict" graph rooted at crm_records. Walk it leaf
  // first. Tables below without their own organization_id are scoped
  // through the ids already verified above (crm_records.person_id,
  // crm_conversations.person_id, crm_conversation_messages.person_id). ---
  const recordRows = await tx.select({ id: crmRecords.id }).from(crmRecords).where(and(inOrg(crmRecords), inArray(crmRecords.personId, ids)));
  const recordIds = recordRows.map((row) => row.id);

  let messageIds: string[] = [];
  let classificationIds: string[] = [];
  let stepRunIds: string[] = [];

  if (recordIds.length) {
    const draftRows = await tx.select({ id: crmDrafts.id }).from(crmDrafts).where(inArray(crmDrafts.crmRecordId, recordIds));
    const draftIds = draftRows.map((row) => row.id);

    const runRows = await tx.select({ id: crmSequenceRuns.id }).from(crmSequenceRuns).where(and(inOrg(crmSequenceRuns), inArray(crmSequenceRuns.crmRecordId, recordIds)));
    const runIds = runRows.map((row) => row.id);

    if (runIds.length) {
      const stepRunRows = await tx.select({ id: crmSequenceStepRuns.id }).from(crmSequenceStepRuns).where(inArray(crmSequenceStepRuns.sequenceRunId, runIds));
      stepRunIds = stepRunRows.map((row) => row.id);
      // crm_drafts.sequence_step_run_id and crm_sequence_step_runs.draft_id
      // point at each other (both restrict, both nullable) — break the
      // cycle before either side can be deleted.
      if (stepRunIds.length) {
        await tx.update(crmSequenceStepRuns).set({ draftId: null }).where(inArray(crmSequenceStepRuns.id, stepRunIds));
      }
    }

    if (draftIds.length) {
      await tx.delete(crmSendAttempts).where(inArray(crmSendAttempts.draftId, draftIds));
      await tx.delete(crmDraftKnowledgeCitations).where(inArray(crmDraftKnowledgeCitations.draftId, draftIds));
      await tx.delete(crmDrafts).where(inArray(crmDrafts.id, draftIds));
    }

    if (stepRunIds.length) {
      await tx.delete(crmSequenceStepRuns).where(inArray(crmSequenceStepRuns.id, stepRunIds));
    }

    const classificationRows = await tx
      .delete(crmClassifications)
      .where(inArray(crmClassifications.crmRecordId, recordIds))
      .returning({ id: crmClassifications.id });
    classificationIds = classificationRows.map((row) => row.id);

    await tx.delete(crmRecordSequenceOverrides).where(inArray(crmRecordSequenceOverrides.crmRecordId, recordIds));

    if (runIds.length) {
      await tx.delete(crmSequenceRuns).where(and(inOrg(crmSequenceRuns), inArray(crmSequenceRuns.id, runIds)));
    }
  }

  await tx.delete(crmEvents).where(and(inOrg(crmEvents), inArray(crmEvents.personId, ids)));

  const messageRows = await tx
    .delete(crmConversationMessages)
    .where(inArray(crmConversationMessages.personId, ids))
    .returning({ id: crmConversationMessages.id });
  messageIds = messageRows.map((row) => row.id);

  await tx.delete(crmConversations).where(and(inOrg(crmConversations), inArray(crmConversations.personId, ids)));

  if (recordIds.length) {
    await tx.delete(crmRecords).where(and(inOrg(crmRecords), inArray(crmRecords.id, recordIds)));
  }

  await tx.delete(crmPersonContactPolicies).where(inArray(crmPersonContactPolicies.personId, ids));

  // An inbound identity exception that resolved to this Person: keep the
  // audit row (it records a past automated decision) but detach the
  // dangling reference instead of deleting it.
  await tx.update(crmIdentityExceptions).set({ resolvedPersonId: null }).where(and(inOrg(crmIdentityExceptions), inArray(crmIdentityExceptions.resolvedPersonId, ids)));

  // Durable job-queue rows for entities we just deleted have nothing left to
  // process; drop them so a worker doesn't pick up a dangling entityId.
  // crm_jobs.entityId carries no foreign key (it is polymorphic), so this is
  // a cleanup, not something the database would otherwise enforce.
  if (messageIds.length) await tx.delete(crmJobs).where(and(eq(crmJobs.entityType, "message"), inArray(crmJobs.entityId, messageIds)));
  if (classificationIds.length) await tx.delete(crmJobs).where(and(eq(crmJobs.entityType, "classification"), inArray(crmJobs.entityId, classificationIds)));
  if (stepRunIds.length) await tx.delete(crmJobs).where(and(eq(crmJobs.entityType, "sequence_step_run"), inArray(crmJobs.entityId, stepRunIds)));

  // Finally the Person rows themselves. Nothing with a restrict reference to
  // personId remains; whatsapp_campaign_leads cascades and whatsapp_chats.
  // person_id is set null by the database as part of this statement.
  const deleted = await tx.delete(people).where(and(inOrg(people), inArray(people.id, ids))).returning({ id: people.id });
  return deleted.map((row) => row.id);
}

/**
 * Delete every Person in `personIds` that belongs to the current
 * organization, and everything across every subsystem that references them.
 * Irreversible. Processes in batches of {@link BATCH_SIZE}, one transaction
 * per batch, so a very large "select all matching" delete doesn't hold one
 * giant transaction open.
 */
export async function deletePeople(personIds: string[]): Promise<number> {
  const unique = [...new Set(personIds)];
  let deleted = 0;
  for (const batch of chunk(unique, BATCH_SIZE)) {
    const ids = await db.transaction((tx) => deleteBatch(tx, batch));
    deleted += ids.length;
  }
  return deleted;
}
