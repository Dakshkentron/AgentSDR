import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { outreachCampaigns, outreachLeads, suppressionList } from "@/lib/outreach/schema";
import { campaigns as linkedinCampaigns, leads as linkedinLeads } from "@/lib/linkedin/schema";
import { isInvitationMessageTooLong } from "@/lib/linkedin/invitationMessage";
import { excludedByCampaign } from "@/lib/linkedin/leadOutreachEligibility";
import { people } from "./schema";
import { getPeopleByIds, withLeadTransaction } from "./records";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

export type AssignmentResult = {
  requested: number;
  added: number;
  skippedMissingIdentity: number;
  skippedDuplicate: number;
  skippedSuppressed: number;
};

export async function addPeopleToEmailCampaign(campaignId: string, personIds: string[]): Promise<AssignmentResult> {
  const uniqueIds = [...new Set(personIds.map((id) => id.trim()).filter(Boolean))];
  return withLeadTransaction(async (tx) => {
    const [campaign] = await tx.select({ id: outreachCampaigns.id }).from(outreachCampaigns).where(and(inOrg(outreachCampaigns), eq(outreachCampaigns.id, campaignId))).limit(1);
    if (!campaign) throw new Error("Email campaign not found");

    if (!uniqueIds.length) {
      return { requested: 0, added: 0, skippedMissingIdentity: 0, skippedDuplicate: 0, skippedSuppressed: 0 };
    }

    const rows = await getPeopleByIds(tx, uniqueIds);
    const emails = rows.flatMap(({ person }) => (person.email ? [person.email] : []));
    const [existingRows, suppressedRows] = await Promise.all([
      tx.select({ personId: outreachLeads.personId }).from(outreachLeads).where(and(eq(outreachLeads.campaignId, campaignId), inArray(outreachLeads.personId, uniqueIds))),
      emails.length
        ? tx.select({ email: suppressionList.email }).from(suppressionList).where(and(inOrg(suppressionList), inArray(suppressionList.email, emails)))
        : [],
    ]);
    const existing = new Set(existingRows.map((row) => row.personId));
    const suppressed = new Set(suppressedRows.map((row) => row.email.toLowerCase()));
    const result: AssignmentResult = { requested: uniqueIds.length, added: 0, skippedMissingIdentity: 0, skippedDuplicate: 0, skippedSuppressed: 0 };

    for (const { person } of rows) {
      if (!person.email) {
        result.skippedMissingIdentity += 1;
        continue;
      }
      if (suppressed.has(person.email)) {
        result.skippedSuppressed += 1;
        continue;
      }
      if (existing.has(person.id)) {
        result.skippedDuplicate += 1;
        continue;
      }
      await tx.insert(outreachLeads).values({ personId: person.id, campaignId, sequenceStatus: "pending" });
      existing.add(person.id);
      result.added += 1;
    }
    result.skippedMissingIdentity += uniqueIds.length - rows.length;
    return result;
  });
}

export type LinkedinSequenceInput = {
  invitationMessage?: string | null;
  acceptanceMessage?: string | null;
  followUp1Message?: string | null;
  followUp2Message?: string | null;
  followUp3Message?: string | null;
};

export async function addPeopleToLinkedinCampaign(
  campaignId: string,
  personIds: string[],
  sequence: LinkedinSequenceInput = {},
): Promise<AssignmentResult> {
  if (isInvitationMessageTooLong(sequence.invitationMessage)) {
    throw new Error("Invitation message exceeds 300 characters");
  }
  const uniqueIds = [...new Set(personIds.map((id) => id.trim()).filter(Boolean))];
  return withLeadTransaction(async (tx) => {
    const [campaign] = await tx.select({ id: linkedinCampaigns.id }).from(linkedinCampaigns).where(and(inOrg(linkedinCampaigns), eq(linkedinCampaigns.id, campaignId))).limit(1);
    if (!campaign) throw new Error("LinkedIn campaign not found");

    const campaignSequence = Object.fromEntries(
      Object.entries(sequence)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, value?.trim() || null]),
    );
    if (Object.keys(campaignSequence).length) {
      await tx.update(linkedinCampaigns).set({ ...campaignSequence, updatedAt: new Date() }).where(and(inOrg(linkedinCampaigns), eq(linkedinCampaigns.id, campaignId)));
    }

    if (!uniqueIds.length) {
      return { requested: 0, added: 0, skippedMissingIdentity: 0, skippedDuplicate: 0, skippedSuppressed: 0 };
    }

    const rows = await getPeopleByIds(tx, uniqueIds);
    const existingRows = await tx.select({ personId: linkedinLeads.personId }).from(linkedinLeads).where(and(eq(linkedinLeads.campaignId, campaignId), inArray(linkedinLeads.personId, uniqueIds)));
    const existing = new Set(existingRows.map((row) => row.personId));
    const result: AssignmentResult = { requested: uniqueIds.length, added: 0, skippedMissingIdentity: 0, skippedDuplicate: 0, skippedSuppressed: 0 };
    const excluded = new Set((await tx.select({ id: people.id }).from(people)
      .where(and(inOrg(people), inArray(people.id, uniqueIds), excludedByCampaign(people.id, campaignId)))).map((row) => row.id));

    for (const { person } of rows) {
      if (!person.linkedinUrl) {
        result.skippedMissingIdentity += 1;
        continue;
      }
      if (existing.has(person.id)) {
        result.skippedDuplicate += 1;
        continue;
      }
      if (excluded.has(person.id)) {
        result.skippedSuppressed += 1;
        continue;
      }
      await tx.insert(linkedinLeads).values({
          organizationId: currentOrganizationId(),
          personId: person.id,
          sourceLinkedinIdentifier: person.linkedinUrl,
          campaignId,
          status: "PENDING",
          updatedAt: new Date(),
      });
      existing.add(person.id);
      result.added += 1;
    }
    result.skippedMissingIdentity += uniqueIds.length - rows.length;
    return result;
  });
}
