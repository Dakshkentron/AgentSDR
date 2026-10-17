import { isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { withLinkedinOrg } from "@/lib/linkedin/organizations.server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createManualDraft } from "@/lib/crm/operations";
import { isPersonDoNotContact } from "@/lib/crm/policies";
import { sendDraft } from "@/lib/crm/send";
import { people } from "@/lib/leads/schema";
import { normalizeLinkedinSlug } from "@/lib/leads/identity";
import { findCrmConversationForConnection } from "@/lib/linkedin/messages/crmContext.server";
import {
  InboxSendError,
  sendFromLinkedinInbox,
} from "@/lib/linkedin/messages/sendFromInbox";
import { connections, leads, linkedInAccounts, messages } from "@/lib/linkedin/schema";
import { deliverMessageToConnection, sendMessage } from "@/services/unipile.service";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

export async function POST(request: NextRequest) {
  return withLinkedinOrg(request, async () => {
    try {
      const body = await request.json();
      const idempotencyKey = request.headers.get("idempotency-key")?.trim() || randomUUID();
      const message = await sendFromLinkedinInbox(
        { ...body, idempotencyKey },
        {
          findConnection: async (connectionId) => {
            const [connection] = await db.select().from(connections)
              .where(and(inOrg(connections), eq(connections.id, connectionId))).limit(1);
            return connection ?? null;
          },
          findNativePersonId: async (connection) => {
            if (connection.leadId) {
              const [lead] = await db.select({ personId: leads.personId }).from(leads)
                .where(and(inOrg(leads), eq(leads.id, connection.leadId))).limit(1);
              if (lead?.personId) return lead.personId;
            }
            const linkedinSlug = normalizeLinkedinSlug(connection.linkedinUrl);
            if (!linkedinSlug) return null;
            const [person] = await db.select({ id: people.id }).from(people)
              .where(and(inOrg(people), eq(people.linkedinUrl, linkedinSlug))).limit(1);
            return person?.id ?? null;
          },
          findCrmConversation: findCrmConversationForConnection,
          isPersonDoNotContact: (personId) => isPersonDoNotContact(db, personId),
          sendThroughCrm: async ({ conversation, text, idempotencyKey: crmIdempotencyKey }) => {
            const draft = await createManualDraft({
              recordId: conversation.recordId,
              conversationId: conversation.id,
              bodyText: text,
            });
            const attempt = await sendDraft({
              draftId: draft.id,
              revision: draft.revision,
              idempotencyKey: crmIdempotencyKey,
              requestId: randomUUID(),
            });
            return {
              id: `crm:${attempt.id}`,
              type: "CUSTOM_SENT" as const,
              text,
              seen: true as const,
              createdAt: new Date().toISOString(),
            };
          },
          sendThroughLinkedin: async (chatId, text, connection) => {
            const [row] = await db.select({ providerId: connections.providerId, accountId: linkedInAccounts.linkedinId })
              .from(connections)
              .leftJoin(linkedInAccounts, and(inOrg(linkedInAccounts), eq(linkedInAccounts.id, connections.linkedinAccountId)))
              .where(and(inOrg(connections), eq(connections.id, connection.id))).limit(1);
            if (!row?.accountId) return sendMessage(chatId, text);
            // Falls back to finding (or starting) the chat by person when the
            // stored chat id is refused, e.g. one issued by a previous provider.
            const delivered = await deliverMessageToConnection(row.providerId, row.accountId, text, chatId);
            if (!delivered.chatId) throw new Error("LinkedIn refused the message — reconnect the account and try again");
            if (delivered.chatId !== chatId) {
              await db.update(connections).set({ chatId: delivered.chatId })
                .where(and(inOrg(connections), eq(connections.id, connection.id)));
            }
            return delivered.messageId;
          },
          saveNativeMessage: async ({ connection, text, providerMessageId }) => {
            const [message] = await db.insert(messages).values({
              organizationId: currentOrganizationId(),
              type: "CUSTOM_SENT",
              text,
              linkedinMessageId: providerMessageId,
              connectionId: connection.id,
              leadId: connection.leadId,
              seen: true,
            }).returning({
              id: messages.id,
              type: messages.type,
              text: messages.text,
              seen: messages.seen,
              createdAt: messages.createdAt,
            });
            if (!message) throw new Error("LinkedIn message insert did not return a row");
            return { ...message, type: "CUSTOM_SENT", seen: true, createdAt: message.createdAt.toISOString() };
          },
        },
      );
      return NextResponse.json({ message });
    } catch (error) {
      if (error instanceof InboxSendError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      if (isPlatformNotConnectedError(error)) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      console.error("[linkedin/messages/send] Failed to send message:", error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Could not send message" },
        { status: 500 },
      );
    }
  });
}
