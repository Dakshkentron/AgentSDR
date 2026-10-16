import "server-only";

import { resolve4, resolve6, resolveMx } from "node:dns/promises";

/**
 * Whether `email`'s domain can receive mail: it has an MX record, or (the
 * RFC 5321 fallback) an address record. Stands in for a confirmation email
 * on an instance with no mail provider — it catches typos and made-up
 * domains, not a made-up mailbox on a real one.
 *
 * Only a definite "no such domain / no records" answer refuses; a DNS
 * timeout or server failure lets the sign-up through rather than locking
 * people out while the resolver is down.
 */
export async function emailDomainAcceptsMail(email: string): Promise<boolean> {
  const domain = email.split("@").pop()?.trim().toLowerCase();
  if (!domain || !domain.includes(".")) return false;
  const definiteNo = (error: unknown) => {
    const code = (error as { code?: string }).code;
    return code === "ENOTFOUND" || code === "ENODATA" || code === "ENONAME";
  };
  try {
    const mx = await resolveMx(domain);
    // A "null MX" (RFC 7505: a single record with an empty exchange) means "accepts no mail".
    return mx.some((record) => record.exchange && record.exchange !== ".");
  } catch (error) {
    if (!definiteNo(error)) return true;
  }
  for (const lookup of [resolve4, resolve6]) {
    try {
      if ((await lookup(domain)).length > 0) return true;
    } catch (error) {
      if (!definiteNo(error)) return true;
    }
  }
  return false;
}
