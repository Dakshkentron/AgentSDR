import "server-only";

import { runInOrganization } from "@/lib/tenancy/scope";
import { findAccount, listAccounts, organizationForToken, withSession, type LeopileAccount } from "./accounts";
import * as li from "./voyager";

/**
 * Leopile's HTTP API, in the shape of Unipile's (`/api/v1/...`), so the
 * Unipile SDK and AgentSDR's LinkedIn engine run against it unchanged. Only
 * what that engine calls is implemented; everything else is a 404/501.
 *
 * Webhooks are accepted and discarded: AgentSDR already polls — the scheduled
 * message sync and invite-acceptance checks read the same endpoints — so
 * nothing waits on a push. Add delivery here if reply latency matters.
 *
 * Ceiling: a conversation list is LinkedIn's first page (about the 20 most
 * recent threads), and chats are not cursor-paged.
 */

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, title: string, type = "errors/invalid_request") => json({ status, type, title }, status);

const iso = (date: Date) => (date.getTime() ? date.toISOString() : null);
const profileUrl = (slug: string) => `https://www.linkedin.com/in/${slug}`;

function accountJson(a: LeopileAccount) {
  return {
    object: "Account",
    id: a.id,
    name: a.name,
    type: "LINKEDIN",
    created_at: a.createdAt.toISOString(),
    sources: [{ id: `${a.id}_MESSAGING`, status: a.status }],
    connection_params: { im: { id: a.memberId, username: a.name, publicIdentifier: a.publicIdentifier } },
  };
}

const chatJson = (a: LeopileAccount, c: li.Conversation) => ({
  object: "Chat",
  id: c.id,
  account_id: a.id,
  type: 0,
  name: c.name,
  attendee_provider_id: c.memberId,
  timestamp: iso(c.lastActivityAt),
});

const messageJson = (a: LeopileAccount, chatId: string, m: li.ChatMessage) => ({
  object: "Message",
  id: m.id,
  chat_id: chatId,
  account_id: a.id,
  sender_id: m.senderId,
  text: m.text,
  timestamp: iso(m.sentAt),
  created_at: iso(m.sentAt),
  is_sender: m.senderId === a.memberId ? 1 : 0,
  attachments: [],
});

/** JSON or form-data body as one object; repeated form fields become arrays. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if ((request.headers.get("content-type") ?? "").includes("json")) return ((await request.json().catch(() => ({}))) as Record<string, unknown>) ?? {};
  const out: Record<string, unknown> = {};
  const form = await request.formData().catch(() => null);
  for (const [key, value] of form?.entries() ?? []) {
    const name = key.replace(/\[\]$/, "");
    out[name] = name in out ? [...[out[name]].flat(), value] : key.endsWith("[]") ? [value] : value;
  }
  return out;
}

export async function handleLeopile(request: Request, path: string[]): Promise<Response> {
  const token = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const organizationId = token ? await organizationForToken(token) : null;
  if (!organizationId) return error(401, "Invalid access token", "errors/invalid_credentials");
  return runInOrganization(organizationId, async () => {
    try {
      return await route(request, path);
    } catch (e) {
      if (e instanceof li.LinkedinAuthError) return error(401, e.message, "errors/disconnected_account");
      console.error("[leopile]", e instanceof Error ? e.message : e);
      return error(500, e instanceof Error ? e.message : "Leopile failed", "errors/unexpected_error");
    }
  });
}

async function route(request: Request, path: string[]): Promise<Response> {
  const { method } = request;
  const query = new URL(request.url).searchParams;
  const [head, second, third] = path;

  if (head === "webhooks") {
    if (method === "GET") return json({ object: "WebhookList", items: [], cursor: null });
    if (method === "POST") return json({ object: "WebhookCreated", webhook_id: "leopile-polling" }, 201);
    return new Response(null, { status: 204 });
  }
  if (head === "accounts" && method === "GET") {
    if (!second) return json({ object: "AccountList", items: (await listAccounts()).map(accountJson), cursor: null });
    const account = await findAccount(second);
    return account ? json(accountJson(account)) : error(404, "Account not found", "errors/resource_not_found");
  }
  if (head === "linkedin" && second === "search") return error(501, "Leopile does not search LinkedIn yet", "errors/feature_not_implemented");

  // Everything below acts as one LinkedIn account.
  const accountId = query.get("account_id") ?? ((await readBody(request.clone())).account_id as string | undefined) ?? "";
  const account = await findAccount(accountId);
  if (!account) return error(404, "Account not found", "errors/resource_not_found");
  if (account.status !== "OK") return error(401, "This LinkedIn account is disconnected — reconnect it in Leopile", "errors/disconnected_account");
  const as = <T>(fn: (session: li.LinkedinSession) => Promise<T>) => withSession(account, fn);

  if (head === "users") {
    if (second === "invite" && method === "POST") {
      const body = await readBody(request);
      const id = await as((s) => li.invite(s, String(body.provider_id ?? ""), String(body.message ?? "")));
      return json({ object: "UserInvitationSent", invitation_id: id }, 201);
    }
    if (second === "relations") {
      const items = (await as((s) => li.relations(s))).map((r) => ({
        object: "UserRelation",
        member_id: r.memberId,
        public_identifier: r.publicIdentifier,
        public_profile_url: profileUrl(r.publicIdentifier),
        created_at: r.connectedAt.getTime(),
      }));
      return json({ object: "UserRelationsList", items, cursor: null });
    }
    if (second && method === "GET") {
      const identifier = decodeURIComponent(second);
      const p = await as((s) => li.profile(s, identifier));
      return json({
        object: "UserProfile",
        provider: "LINKEDIN",
        provider_id: p.memberId,
        public_identifier: p.publicIdentifier,
        public_profile_url: profileUrl(p.publicIdentifier),
        first_name: p.firstName,
        last_name: p.lastName,
        headline: p.headline,
        location: p.location,
        profile_picture_url: p.pictureUrl,
        work_experience: p.position || p.company ? [{ position: p.position, company: p.company, current: true }] : [],
      });
    }
  }

  if (head === "chat_attendees" && second && third === "chats") {
    const chat = (await as((s) => li.conversationWith(s, account.memberId, second))) ?? null;
    return json({ object: "ChatList", items: chat ? [chatJson(account, chat)] : [], cursor: null });
  }

  if (head === "chats") {
    if (!second && method === "GET") {
      const after = query.get("after") ? new Date(query.get("after")!).getTime() : 0;
      const items = (await as((s) => li.conversations(s, account.memberId))).filter((c) => c.lastActivityAt.getTime() > after).map((c) => chatJson(account, c));
      return json({ object: "ChatList", items, cursor: null });
    }
    if (!second && method === "POST") {
      const body = await readBody(request);
      const attendee = [body.attendees_ids].flat()[0];
      if (!attendee || typeof body.text !== "string") return error(422, "attendees_ids and text are required");
      const started = await as((s) => li.startConversation(s, String(attendee), body.text as string));
      return json({ object: "ChatStarted", chat_id: started.conversationId, message_id: started.messageId }, 201);
    }
    if (second && third === "attendees") {
      const chat = (await as((s) => li.conversations(s, account.memberId))).find((c) => c.id === second);
      return json({
        object: "ChatAttendeeList",
        items: [
          { object: "ChatAttendee", id: account.memberId, provider_id: account.memberId, name: account.name, is_self: 1, profile_url: profileUrl(account.publicIdentifier) },
          ...(chat ? [{ object: "ChatAttendee", id: chat.memberId, provider_id: chat.memberId, name: chat.name, is_self: 0 }] : []),
        ],
        cursor: null,
      });
    }
    if (second && third === "messages" && method === "GET") {
      const items = (await as((s) => li.messagesOf(s, second))).map((m) => messageJson(account, second, m));
      return json({ object: "MessageList", items, cursor: null });
    }
    if (second && third === "messages" && method === "POST") {
      const body = await readBody(request);
      if (typeof body.text !== "string" || !body.text) return error(422, "text is required");
      const id = await as((s) => li.sendMessage(s, second, body.text as string));
      return json({ object: "MessageSent", message_id: id }, 201);
    }
  }

  if (head === "messages" && !second && method === "GET") {
    const after = query.get("after") ? new Date(query.get("after")!).getTime() : 0;
    const items: ReturnType<typeof messageJson>[] = [];
    for (const chat of (await as((s) => li.conversations(s, account.memberId))).filter((c) => c.lastActivityAt.getTime() > after).slice(0, 25)) {
      for (const m of await as((s) => li.messagesOf(s, chat.id))) if (m.sentAt.getTime() > after) items.push(messageJson(account, chat.id, m));
    }
    return json({ object: "MessageList", items, cursor: null });
  }

  return error(404, "Not found", "errors/resource_not_found");
}
