import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { connections, leads, linkedInAccounts, messages } from "@/lib/linkedin/schema";
import { requirePlatformCredentials } from "@/lib/platform/credentials";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

/**
 * Pulls existing LinkedIn conversations from Unipile into the inbox.
 *
 * Webhooks only deliver messages that arrive after they are registered, so
 * history (and anything sent while they pointed elsewhere) never reaches the
 * app without this. It is a plain backfill: it stores conversations and
 * messages, both directions, and never changes a lead's status, sends
 * anything, or forwards to the CRM. Messages are matched on Unipile's message
 * id, the same id the webhook stores, so running it again or alongside the
 * webhook adds nothing twice.
 */

const PAGE_SIZE = 100;
// ponytail: caps keep one click bounded; raise them if an inbox outgrows them.
const MAX_CHATS_PER_ACCOUNT = 2000;
const MAX_MESSAGES_PER_CHAT = 500;

type UnipileChat = { id: string; type?: number; attendee_provider_id?: string | null; timestamp?: string | null };
type Page<T> = { items?: T[]; cursor?: string | null };
type UnipileMessage = {
  id: string;
  text?: string | null;
  timestamp?: string | null;
  is_sender?: number | boolean;
  attachments?: { type?: string; file_name?: string }[];
};

const ATTACHMENT_LABELS: Record<string, string> = {
  img: "📷 Photo",
  video: "🎥 Video",
  audio: "🎤 Voice message",
  linkedin_post: "🔗 Shared a LinkedIn post",
};

/** The message's text, or a label for what it carried when it has none (photo, file, …). */
export function messageText(m: UnipileMessage): string | null {
  if (m.text?.trim()) return m.text;
  const labels = (m.attachments ?? []).map((a) =>
    a.type === "file" ? `📎 ${a.file_name || "File"}` : (ATTACHMENT_LABELS[a.type ?? ""] ?? "📎 Attachment"),
  );
  return labels.length ? labels.join("\n") : null;
}
type UnipileAttendee = {
  provider_id?: string;
  name?: string | null;
  is_self?: number | boolean;
  picture_url?: string | null;
  profile_url?: string | null;
  specifics?: { occupation?: string | null } | null;
};

export type MessageSyncResult = { accounts: number; conversations: number; messages: number };

export async function syncLinkedinMessages(): Promise<MessageSyncResult> {
  const { baseUrl, apiKey } = await requirePlatformCredentials("unipile");
  const unipile = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      headers: { "X-API-KEY": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Unipile answered ${response.status} to GET ${path}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    return response.json() as Promise<T>;
  };
  /** Every item of a cursor-paged Unipile list, up to `cap`. */
  const all = async <T>(path: string, cap: number): Promise<T[]> => {
    const items: T[] = [];
    let cursor: string | null = null;
    do {
      const page: Page<T> = await unipile<Page<T>>(`${path}${path.includes("?") ? "&" : "?"}limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      items.push(...(page.items ?? []));
      cursor = page.cursor ?? null;
    } while (cursor && items.length < cap);
    return items;
  };

  const accounts = await db.select().from(linkedInAccounts).where(inOrg(linkedInAccounts));
  const result: MessageSyncResult = { accounts: accounts.length, conversations: 0, messages: 0 };

  for (const account of accounts) {
    const chats = await all<UnipileChat>(`/chats?account_id=${encodeURIComponent(account.linkedinId)}`, MAX_CHATS_PER_ACCOUNT);
    for (const chat of chats) {
      // ponytail: one-to-one chats only; group threads have no single person to file them under.
      if (chat.type !== undefined && chat.type !== 0) continue;

      const attendees = await unipile<{ items?: UnipileAttendee[] }>(`/chats/${encodeURIComponent(chat.id)}/attendees`);
      const other = (attendees.items ?? []).find((a) => !a.is_self && a.provider_id);
      const providerId = other?.provider_id ?? chat.attendee_provider_id;
      if (!providerId) continue;

      const history = await all<UnipileMessage>(`/chats/${encodeURIComponent(chat.id)}/messages`, MAX_MESSAGES_PER_CHAT);
      // ponytail: every sync re-reads each chat's full history (deduped on insert) so nothing older is ever missed; skip unchanged chats if inboxes get large.
      const items = history.flatMap((m) => {
        const text = messageText(m);
        return m.id && text ? [{ ...m, text }] : [];
      });
      if (items.length === 0) continue;

      const [lead] = await db
        .select({ id: leads.id })
        .from(leads)
        .where(and(inOrg(leads), eq(leads.providerId, providerId), eq(leads.linkedinAccountId, account.id), isNull(leads.supersededByLeadId)))
        .limit(1);

      const now = new Date();
      const firstAt = items.reduce<Date | null>((min, m) => {
        const at = m.timestamp ? new Date(m.timestamp) : null;
        return at && (!min || at < min) ? at : min;
      }, null);
      const [connection] = await db
        .insert(connections)
        .values({
          organizationId: currentOrganizationId(),
          providerId,
          name: other?.name ?? null,
          headline: other?.specifics?.occupation ?? null,
          profilePictureUrl: other?.picture_url ?? null,
          linkedinUrl: other?.profile_url ?? null,
          chatId: chat.id,
          leadId: lead?.id ?? null,
          linkedinAccountId: account.id,
          // First message in the chat, so an unrelated sync does not make it look new.
          connectedAt: firstAt ?? now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [connections.providerId, connections.linkedinAccountId],
          set: { chatId: chat.id, updatedAt: now },
        })
        .returning({ id: connections.id, leadId: connections.leadId });

      const stored = await db
        .select({ linkedinMessageId: messages.linkedinMessageId })
        .from(messages)
        .where(and(inOrg(messages), inArray(messages.linkedinMessageId, items.map((m) => m.id))));
      const known = new Set(stored.map((row) => row.linkedinMessageId));
      const fresh = items.filter((m) => !known.has(m.id));
      if (fresh.length > 0) {
        await db.insert(messages).values(
          fresh.map((m) => ({
            organizationId: currentOrganizationId(),
            type: m.is_sender ? ("CUSTOM_SENT" as const) : ("RECEIVED" as const),
            text: m.text,
            linkedinMessageId: m.id,
            connectionId: connection.id,
            leadId: connection.leadId,
            // History is already read on LinkedIn; only live webhook messages count as unseen.
            seen: true,
            createdAt: m.timestamp ? new Date(m.timestamp) : now,
          })),
        );
      }
      result.conversations += 1;
      result.messages += fresh.length;
    }
  }

  // Earlier syncs stamped connectedAt with the sync time; pull it back to the first message.
  await db.execute(sql`
    UPDATE ${connections} c SET "connectedAt" = first."at"
    FROM (
      SELECT m."connectionId", MIN(m."createdAt") AS "at" FROM ${messages} m
      WHERE m."organizationId" = ${currentOrganizationId()} GROUP BY m."connectionId"
    ) first
    WHERE c."id" = first."connectionId" AND c."organizationId" = ${currentOrganizationId()}
      AND c."connectedAt" > first."at"
  `);
  return result;
}
