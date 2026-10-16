import { expect, test } from "bun:test";
import { parseConversations, parseMe, parseMessages, parseProfile, parseRelations, sessionFrom, urnId } from "./voyager";

// Fixtures are hand-written from LinkedIn's documented-by-use payload shapes, not recorded from a live account.

test("sessionFrom strips the cookie name and quotes, and invents a CSRF token when none is given", () => {
  expect(sessionFrom("li_at=AQED123; Path=/", '"ajax:42"')).toEqual({ liAt: "AQED123", jsessionid: "ajax:42" });
  expect(sessionFrom("AQED123").jsessionid).toMatch(/^ajax:\d+/);
});

test("urnId takes the id off a URN", () => {
  expect(urnId("urn:li:fs_miniProfile:ACoAAB1")).toBe("ACoAAB1");
  expect(urnId(undefined)).toBe("");
});

test("parseMe reads the member from /me, top level or included", () => {
  const mini = { firstName: "Ada", lastName: "Lovelace", publicIdentifier: "ada", entityUrn: "urn:li:fs_miniProfile:ACoAAME" };
  expect(parseMe({ miniProfile: mini })).toEqual({ memberId: "ACoAAME", publicIdentifier: "ada", name: "Ada Lovelace" });
  expect(parseMe({ data: {}, included: [mini] }).memberId).toBe("ACoAAME");
  expect(() => parseMe({})).toThrow();
});

test("parseProfile picks the current position", () => {
  const body = {
    profile: { firstName: "Grace", lastName: "Hopper", headline: "Admiral", locationName: "NYC", entityUrn: "urn:li:fs_profile:ACoAAGH", miniProfile: { publicIdentifier: "grace" } },
    positionView: { elements: [{ title: "Rear Admiral", companyName: "Navy", timePeriod: { endDate: { year: 1986 } } }, { title: "Consultant", companyName: "DEC", timePeriod: { startDate: { year: 1986 } } }] },
  };
  expect(parseProfile(body, "grace")).toMatchObject({ memberId: "ACoAAGH", publicIdentifier: "grace", position: "Consultant", company: "DEC", firstName: "Grace" });
  expect(() => parseProfile({}, "nobody")).toThrow("nobody");
});

test("parseRelations reads connections with their connection time", () => {
  const body = { elements: [{ createdAt: 1_700_000_000_000, connectedMemberResolutionResult: { entityUrn: "urn:li:fsd_profile:ACoAAX", publicIdentifier: "x" } }, { createdAt: 1 }] };
  expect(parseRelations(body)).toEqual([{ memberId: "ACoAAX", publicIdentifier: "x", connectedAt: new Date(1_700_000_000_000) }]);
});

const member = (id: string, first: string) => ({ "com.linkedin.voyager.messaging.MessagingMember": { miniProfile: { entityUrn: `urn:li:fs_miniProfile:${id}`, firstName: first, lastName: "L" } } });

test("parseConversations keeps one-to-one threads and names the other person", () => {
  const body = {
    elements: [
      { entityUrn: "urn:li:fs_conversation:2-AAA", lastActivityAt: 5, participants: [member("ME", "Me"), member("THEM", "Tess")] },
      { entityUrn: "urn:li:fs_conversation:2-GROUP", participants: [member("ME", "Me"), member("A", "A"), member("B", "B")] },
    ],
  };
  expect(parseConversations(body, "ME")).toEqual([{ id: "2-AAA", memberId: "THEM", name: "Tess L", lastActivityAt: new Date(5) }]);
});

test("parseMessages reads text and sender, skipping events without text", () => {
  const event = (id: string, from: string, text?: string) => ({
    entityUrn: `urn:li:fs_event:(2-AAA,${id})`,
    createdAt: 10,
    from: member(from, "x"),
    eventContent: text === undefined ? {} : { "com.linkedin.voyager.messaging.event.MessageEvent": { attributedBody: { text } } },
  });
  const out = parseMessages({ elements: [event("1", "THEM", "hi"), event("2", "ME")] });
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ senderId: "THEM", text: "hi", sentAt: new Date(10) });
});
