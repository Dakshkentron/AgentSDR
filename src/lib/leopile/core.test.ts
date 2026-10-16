import { expect, test } from "bun:test";
import { hashToken, leopileDsn, newAccessToken } from "./core";

test("the DSN is the app's own origin plus /api/leopile", () => {
  expect(leopileDsn("https://app.example.com/")).toBe("https://app.example.com/api/leopile");
});

test("an access token is leo_ + 48 hex, and only its hash is kept", () => {
  const { accessToken, tokenHash } = newAccessToken();
  expect(accessToken).toMatch(/^leo_[0-9a-f]{48}$/);
  expect(tokenHash).toBe(hashToken(accessToken));
  expect(tokenHash).not.toContain(accessToken);
  expect(newAccessToken().accessToken).not.toBe(accessToken);
});
