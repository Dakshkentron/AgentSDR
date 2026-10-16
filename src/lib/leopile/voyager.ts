// LinkedIn's private web API ("Voyager"), called with a member's own session
// cookies — what the logged-in LinkedIn website itself does. It is not a
// supported API: LinkedIn changes it without notice and forbids automating it
// in its terms, so every call here is best-effort, parsed defensively, and a
// refusal (401/403) surfaces as LinkedinAuthError so the account is marked
// disconnected instead of retried. Verified only against fixtures, not a live
// account — see voyager.test.ts.
import { randomUUID } from "node:crypto";

export type LinkedinSession = { liAt: string; jsessionid: string };

export class LinkedinAuthError extends Error {
  constructor() {
    super("LinkedIn rejected the session cookies — they have expired or been revoked");
    this.name = "LinkedinAuthError";
  }
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- LinkedIn's payloads are untyped; each field is checked where read

/** JSESSIONID is a double-submit CSRF token: any `ajax:<digits>` works if cookie and header agree. */
export function sessionFrom(liAt: string, jsessionid?: string): LinkedinSession {
  const csrf = (jsessionid ?? "").replace(/"/g, "").trim() || `ajax:${Math.floor(Math.random() * 1e19)}`;
  return { liAt: liAt.trim().replace(/^li_at=/, "").replace(/;.*$/, ""), jsessionid: csrf };
}

export async function voyager(session: LinkedinSession, path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<Json> {
  const response = await fetch(`https://www.linkedin.com/voyager/api${path}`, {
    method: init.method ?? "GET",
    headers: {
      cookie: `li_at=${session.liAt}; JSESSIONID="${session.jsessionid}"`,
      "csrf-token": session.jsessionid,
      accept: "application/vnd.linkedin.normalized+json+2.1",
      "x-restli-protocol-version": "2.0.0",
      "x-li-lang": "en_US",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      ...(init.body === undefined ? {} : { "content-type": "application/json; charset=UTF-8" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  // A redirect is LinkedIn sending a logged-out visitor to the login page.
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) throw new LinkedinAuthError();
  if (!response.ok) throw new Error(`LinkedIn answered ${response.status} to ${init.method ?? "GET"} ${path.split("?")[0]}`);
  return (await response.json().catch(() => ({}))) as Json;
}

/** `urn:li:fs_miniProfile:ACoAA…` → `ACoAA…` */
export const urnId = (urn: unknown): string => (typeof urn === "string" ? (urn.split(":").pop() ?? "") : "");

/** Every object in a normalized response (top level and `included`) so a reader can find its record wherever LinkedIn put it. */
const records = (body: Json): Json[] => [body, ...(Array.isArray(body.included) ? body.included : []), ...(body.data && typeof body.data === "object" ? [body.data] : [])];

export type Me = { memberId: string; publicIdentifier: string; name: string };

export function parseMe(body: Json): Me {
  const mini = records(body).find((r) => r.miniProfile)?.miniProfile ?? records(body).find((r) => r.publicIdentifier && r.entityUrn);
  const memberId = urnId(mini?.entityUrn);
  if (!memberId || !mini?.publicIdentifier) throw new Error("LinkedIn returned no profile for these cookies");
  return { memberId, publicIdentifier: mini.publicIdentifier, name: [mini.firstName, mini.lastName].filter(Boolean).join(" ") || mini.publicIdentifier };
}

export const me = async (session: LinkedinSession): Promise<Me> => parseMe(await voyager(session, "/me"));

export type Profile = {
  memberId: string;
  publicIdentifier: string;
  firstName: string | null;
  lastName: string | null;
  headline: string;
  location: string | null;
  pictureUrl: string | null;
  position: string | null;
  company: string | null;
};

export function parseProfile(body: Json, identifier: string): Profile {
  const p: Json | undefined = body.profile ?? records(body).find((r) => r.firstName && r.entityUrn);
  const memberId = urnId(p?.entityUrn);
  if (!memberId) throw new Error(`LinkedIn has no profile for ${identifier}`);
  const positions: Json[] = body.positionView?.elements ?? records(body).filter((r) => typeof r.companyName === "string" && typeof r.title === "string");
  const current = positions.find((position) => !position.timePeriod?.endDate) ?? positions[0];
  const art = p?.miniProfile?.picture?.["com.linkedin.common.VectorImage"];
  return {
    memberId,
    publicIdentifier: p?.miniProfile?.publicIdentifier ?? identifier,
    firstName: p?.firstName ?? null,
    lastName: p?.lastName ?? null,
    headline: p?.headline ?? "",
    location: p?.locationName ?? null,
    pictureUrl: art?.rootUrl && art.artifacts?.length ? `${art.rootUrl}${art.artifacts[art.artifacts.length - 1].fileIdentifyingUrlPathSegment}` : null,
    position: current?.title ?? null,
    company: current?.companyName ?? null,
  };
}

export const profile = async (session: LinkedinSession, identifier: string): Promise<Profile> =>
  parseProfile(await voyager(session, `/identity/profiles/${encodeURIComponent(identifier)}/profileView`), identifier);

/** Sends a connection request; LinkedIn answers 201 with no useful id, so the id is ours. */
export async function invite(session: LinkedinSession, memberId: string, message: string): Promise<string> {
  const trackingId = randomUUID();
  await voyager(session, "/growth/normInvitations", {
    method: "POST",
    body: {
      trackingId,
      emberEntityName: "growth/invitation/norm-invitation",
      invitee: { "com.linkedin.voyager.growth.invitation.InviteeProfile": { profileId: memberId } },
      ...(message ? { message } : {}),
    },
  });
  return trackingId;
}

export type Relation = { memberId: string; publicIdentifier: string; connectedAt: Date };

export function parseRelations(body: Json): Relation[] {
  const elements: Json[] = body.elements ?? body.data?.elements ?? [];
  const byUrn = new Map(records(body).filter((r) => typeof r.entityUrn === "string").map((r) => [r.entityUrn as string, r]));
  return elements.flatMap((element) => {
    const urn = element.connectedMember ?? element["*connectedMemberResolutionResult"];
    const member: Json | undefined = element.connectedMemberResolutionResult ?? (typeof urn === "string" ? byUrn.get(urn) : undefined);
    const memberId = urnId(member?.entityUrn ?? urn);
    if (!memberId) return [];
    return [{ memberId, publicIdentifier: member?.publicIdentifier ?? "", connectedAt: new Date(element.createdAt ?? 0) }];
  });
}

export async function relations(session: LinkedinSession): Promise<Relation[]> {
  const out: Relation[] = [];
  for (let start = 0; start < 1000; start += 40) {
    const page = parseRelations(
      await voyager(session, `/relationships/dash/connections?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16&count=40&q=search&sortType=RECENTLY_ADDED&start=${start}`),
    );
    out.push(...page);
    if (page.length < 40) break;
  }
  return out;
}

const MEMBER = "com.linkedin.voyager.messaging.MessagingMember";
const MESSAGE_EVENT = "com.linkedin.voyager.messaging.event.MessageEvent";

export type Conversation = { id: string; memberId: string; name: string; lastActivityAt: Date };
export type ChatMessage = { id: string; senderId: string; text: string; sentAt: Date };

export function parseConversations(body: Json, selfId: string): Conversation[] {
  const elements: Json[] = body.elements ?? records(body).filter((r) => typeof r.entityUrn === "string" && r.entityUrn.includes("fs_conversation"));
  return elements.flatMap((element) => {
    const others: Json[] = (element.participants ?? []).map((p: Json) => p[MEMBER]?.miniProfile ?? p.miniProfile).filter((mini: Json | undefined) => mini && urnId(mini.entityUrn) !== selfId);
    // One-to-one threads only: group threads have no single person to file them under.
    if (others.length !== 1) return [];
    const other = others[0]!;
    return [{ id: urnId(element.entityUrn), memberId: urnId(other.entityUrn), name: [other.firstName, other.lastName].filter(Boolean).join(" "), lastActivityAt: new Date(element.lastActivityAt ?? 0) }];
  });
}

export function parseMessages(body: Json): ChatMessage[] {
  const elements: Json[] = body.elements ?? records(body).filter((r) => r.eventContent);
  return elements.flatMap((event) => {
    const text = event.eventContent?.[MESSAGE_EVENT]?.attributedBody?.text ?? event.eventContent?.attributedBody?.text;
    if (typeof text !== "string") return [];
    const from = event.from?.[MEMBER]?.miniProfile ?? event.from?.miniProfile;
    return [{ id: urnId(event.dashEntityUrn ?? event.entityUrn), senderId: urnId(from?.entityUrn), text, sentAt: new Date(event.createdAt ?? 0) }];
  });
}

export async function conversations(session: LinkedinSession, selfId: string): Promise<Conversation[]> {
  return parseConversations(await voyager(session, "/messaging/conversations?keyVersion=LEGACY_INBOX"), selfId);
}

export async function conversationWith(session: LinkedinSession, selfId: string, memberId: string): Promise<Conversation | null> {
  const found = parseConversations(await voyager(session, `/messaging/conversations?keyVersion=LEGACY_INBOX&q=participants&recipients=List(${encodeURIComponent(memberId)})`), selfId);
  return found.find((c) => c.memberId === memberId) ?? null;
}

export async function messagesOf(session: LinkedinSession, conversationId: string): Promise<ChatMessage[]> {
  return parseMessages(await voyager(session, `/messaging/conversations/${encodeURIComponent(conversationId)}/events`));
}

const messageCreate = (text: string) => ({ "com.linkedin.voyager.messaging.create.MessageCreate": { attributedBody: { text, attributes: [] }, attachments: [] } });

/** Replies in an existing thread. LinkedIn's answer carries no stable id, so a client token stands in. */
export async function sendMessage(session: LinkedinSession, conversationId: string, text: string): Promise<string> {
  const originToken = randomUUID();
  await voyager(session, `/messaging/conversations/${encodeURIComponent(conversationId)}/events?action=create`, {
    method: "POST",
    body: { eventCreate: { originToken, value: messageCreate(text) }, dedupeByClientGeneratedToken: false },
  });
  return originToken;
}

/** Opens a thread with a first-degree connection; returns the new conversation id. */
export async function startConversation(session: LinkedinSession, memberId: string, text: string): Promise<{ conversationId: string; messageId: string }> {
  const originToken = randomUUID();
  const body = await voyager(session, "/messaging/conversations?action=create", {
    method: "POST",
    body: { conversationCreate: { eventCreate: { originToken, value: messageCreate(text) }, subtype: "MEMBER_TO_MEMBER", recipients: [memberId] } },
  });
  const urn = JSON.stringify(body).match(/urn:li:fs_conversation:([^"\\]+)/)?.[1];
  if (!urn) throw new Error("LinkedIn did not say which conversation the message started");
  return { conversationId: urn, messageId: originToken };
}
