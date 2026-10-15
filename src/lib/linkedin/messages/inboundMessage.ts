import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages } from "@/lib/linkedin/schema";
import { forwardReplyToAgentSdr } from "./forwardToAgentSdr";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

type InboundMessageInput = {
  text: string;
  linkedinMessageId?: string | null;
  connectionId: string;
  leadId?: string | null;
  /** CUSTOM_SENT for our own message sent straight from LinkedIn; read already. */
  type?: "RECEIVED" | "CUSTOM_SENT";
  /**
   * Display/identity context for forwarding this reply to AgentSDR_v2's CRM.
   * Omit when the sender is not a canonical campaign Person; the message will
   * remain available in the LinkedIn inbox without becoming CRM work.
   */
  forward?: {
    /** Canonical Person identity is required before CRM forwarding. */
    personId: string;
    providerId: string;
    name?: string | null;
    headline?: string | null;
    linkedinUrl?: string | null;
    chatId?: string | null;
    accountId?: string | null;
    accountUsername?: string | null;
    sentAt?: Date | null;
  };
};

/** Persist an inbound webhook message; skip if linkedinMessageId already exists. */
export const saveInboundMessage = async (input: InboundMessageInput): Promise<"saved" | "duplicate"> => {
  const linkedinMessageId = input.linkedinMessageId;
  const saved = linkedinMessageId
    ? await db.transaction(async (tx) => {
        // Unipile documents message_id on message_received deliveries and may
        // retry a webhook up to five times. Serialize on that provider ID so
        // concurrent retries cannot both pass a SELECT-then-INSERT check.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`linkedin-message:${linkedinMessageId}`}, 0))`);
        const [existing] = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(inOrg(messages), eq(messages.linkedinMessageId, linkedinMessageId)))
          .limit(1);
        if (existing) return false;
        await tx.insert(messages).values({
          organizationId: currentOrganizationId(),
          type: input.type ?? "RECEIVED",
          text: input.text,
          linkedinMessageId,
          connectionId: input.connectionId,
          leadId: input.leadId ?? null,
          seen: input.type === "CUSTOM_SENT",
        });
        return true;
      })
    : await db.insert(messages).values({
        organizationId: currentOrganizationId(),
        type: input.type ?? "RECEIVED",
        text: input.text,
        linkedinMessageId: null,
        connectionId: input.connectionId,
        leadId: input.leadId ?? null,
        seen: input.type === "CUSTOM_SENT",
      }).then(() => true);

  if (input.forward) {
    const payload = {
      personId: input.forward.personId,
      providerId: input.forward.providerId,
      name: input.forward.name ?? null,
      headline: input.forward.headline ?? null,
      linkedinUrl: input.forward.linkedinUrl ?? null,
      chatId: input.forward.chatId ?? null,
      accountId: input.forward.accountId ?? null,
      accountUsername: input.forward.accountUsername ?? null,
      messageText: input.text,
      linkedinMessageId: input.linkedinMessageId ?? null,
      sentAt: input.forward.sentAt ?? null,
    };
    // CRM ingestion is durable: await it even on a duplicate native save so
    // a prior forwarding failure is retried against CRM's own idempotency key.
    await forwardReplyToAgentSdr(payload, { throwOnError: true });
  }

  return saved ? "saved" : "duplicate";
};
