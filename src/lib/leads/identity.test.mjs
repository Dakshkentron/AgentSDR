import { describe, expect, test } from "bun:test";
import {
  isLinkedinMemberId,
  linkedinProfileUrl,
  inferCompanyDomainFromEmail,
  inferLinkedinApi,
  linkedinLookupIdentifier,
  linkedinSourceIdentityKey,
  legacyPersonIdentityKey,
  normalizeCompanyDomain,
  normalizeEmail,
  normalizeLinkedinSlug,
  normalizeLinkedinSourceIdentifier,
  publicSlugFromSourceIdentifier,
} from "./identity.ts";

describe("canonical lead identities", () => {
  test("normalizes email", () => {
    expect(normalizeEmail("  Person@Example.COM ")).toBe("person@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("person@")).toBeNull();
  });

  test("normalizes LinkedIn URLs to a bare slug", () => {
    expect(normalizeLinkedinSlug("https://www.linkedin.com/in/JaneDoe42/?trk=x")).toBe("janedoe42");
    expect(normalizeLinkedinSlug("JaneDoe42")).toBe("janedoe42");
    expect(normalizeLinkedinSlug("https://example.com/in/JaneDoe42")).toBeNull();
  });

  test("accepts vanity slugs that start with a hyphen or underscore", () => {
    expect(normalizeLinkedinSlug("-dhruvkhanna")).toBe("-dhruvkhanna");
    expect(normalizeLinkedinSlug("_sandhya-suresh")).toBe("_sandhya-suresh");
    expect(normalizeLinkedinSlug("https://www.linkedin.com/in/-dhruvkhanna")).toBe("-dhruvkhanna");
  });

  test("reuses a source identifier as the public slug only when it is one", () => {
    expect(publicSlugFromSourceIdentifier("-dhruvkhanna")).toBe("-dhruvkhanna");
    expect(publicSlugFromSourceIdentifier("https://www.linkedin.com/in/JaneDoe42")).toBe("janedoe42");
    expect(publicSlugFromSourceIdentifier("ACoAAAtuUW0BEbuhty5xzbvhjYA2-taV-1Utu5Q")).toBeNull();
    expect(
      publicSlugFromSourceIdentifier("https://www.linkedin.com/in/ACoAAAQq3EUBT8ys0TyojYSj01K95OZB5rCKMNc")
    ).toBeNull();
    expect(publicSlugFromSourceIdentifier("https://www.linkedin.com/sales/lead/ACwAAEncoded,NAME,abc")).toBeNull();
    expect(publicSlugFromSourceIdentifier(null)).toBeNull();
  });

  test("keeps opaque LinkedIn search identifiers separate from public slugs", () => {
    const source = " https://www.linkedin.com/sales/lead/ACwAAEncoded,NAME,abc/ ";
    expect(normalizeLinkedinSourceIdentifier(source)).toBe("https://www.linkedin.com/sales/lead/ACwAAEncoded,NAME,abc");
    expect(inferLinkedinApi(source)).toBe("sales_navigator");
    expect(linkedinLookupIdentifier(source)).toBe("ACwAAEncoded,NAME,abc");
  });

  test("namespaces unresolved identifiers by provider API", () => {
    expect(linkedinSourceIdentityKey(" ABC ", "sales_navigator")).toBe("source:sales_navigator:abc");
    expect(linkedinSourceIdentityKey("ABC", "recruiter")).toBe("source:recruiter:abc");
  });

  test("groups legacy rows by email before LinkedIn, matching person upsert", () => {
    expect(legacyPersonIdentityKey({ email: " Pat@Example.com ", linkedinUrl: "old-slug" })).toBe("email:pat@example.com");
    expect(legacyPersonIdentityKey({ linkedinUrl: "https://linkedin.com/in/pat" })).toBe("linkedin:pat");
  });

  test("decodes the identifier only when preparing the Unipile lookup", () => {
    const source = "https://www.linkedin.com/in/Jos%C3%A9-Test";
    expect(normalizeLinkedinSourceIdentifier(source)).toBe(source);
    expect(linkedinLookupIdentifier(source)).toBe("José-Test");
    expect(normalizeLinkedinSlug(source)).toBe("josé-test");
  });

  test("normalizes company domains", () => {
    expect(normalizeCompanyDomain("https://www.Example.com/about")).toBe("example.com");
    expect(normalizeCompanyDomain(" ")).toBeNull();
  });

  test("infers only business domains from email", () => {
    expect(inferCompanyDomainFromEmail("pat@acme.com")).toBe("acme.com");
    expect(inferCompanyDomainFromEmail("pat@gmail.com")).toBeNull();
  });
});

describe("linkedinProfileUrl", () => {
  test("canonicalises URLs, slugs and member ids, falling back in order", () => {
    expect(linkedinProfileUrl("jngarvit07")).toBe("https://www.linkedin.com/in/jngarvit07/");
    expect(linkedinProfileUrl("linkedin.com/in/jane-doe?x=1")).toBe("https://www.linkedin.com/in/jane-doe/");
    expect(linkedinProfileUrl(null, "", "ACoAAAtuUW0AbCdEfGhIjKlMnOp")).toBe("https://www.linkedin.com/in/ACoAAAtuUW0AbCdEfGhIjKlMnOp/");
    expect(linkedinProfileUrl("https://www.linkedin.com/sales/lead/x,y", "jane")).toBe("https://www.linkedin.com/in/jane/");
    expect(linkedinProfileUrl("not a slug", undefined)).toBeNull();
  });
});

describe("isLinkedinMemberId", () => {
  test("accepts bare member ids only", () => {
    expect(isLinkedinMemberId("ACoAAAtuUW0AbCdEfGhIjKlMnOp")).toBe(true);
    expect(isLinkedinMemberId("jane-doe")).toBe(false);
    expect(isLinkedinMemberId("linkedin.com/in/ACoAAAtuUW0AbCdEfGhIjKlMnOp")).toBe(false);
    expect(isLinkedinMemberId(null)).toBe(false);
  });
});
