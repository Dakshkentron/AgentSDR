// Leopile — a Unipile-compatible connection provider hosted inside AgentSDR.
// A workspace is an organization's access token; AgentSDR connects to it by
// saving the Unipile integration with this app's own address as the DSN, so
// the whole LinkedIn engine (campaigns, inbox, sync) runs on it unchanged.
//
// Pure and free of database access so it tests without the app.
import { createHash, randomBytes } from "node:crypto";

/** Where Unipile's SDK sends requests: `${dsn}/api/v1/...`, served by src/app/api/leopile/api/v1. */
export function leopileDsn(appOrigin: string): string {
  return `${appOrigin.replace(/\/+$/, "")}/api/leopile`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A new access token. Shown once; only its hash is stored. */
export function newAccessToken(): { accessToken: string; tokenHash: string } {
  const accessToken = `leo_${randomBytes(24).toString("hex")}`;
  return { accessToken, tokenHash: hashToken(accessToken) };
}
