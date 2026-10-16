import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { decryptIntegrationCredentials, encryptIntegrationCredentials } from "@/lib/integrations/credentials";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { leopileAccounts, leopileWorkspaces } from "./schema";
import { hashToken, newAccessToken } from "./core";
import { LinkedinAuthError, me, sessionFrom, type LinkedinSession } from "./voyager";

export type LeopileAccount = typeof leopileAccounts.$inferSelect;

/** The organization an access token belongs to. Runs outside any scope: this is how the scope is found. */
export async function organizationForToken(token: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: leopileWorkspaces.organizationId })
    .from(leopileWorkspaces)
    .where(eq(leopileWorkspaces.tokenHash, hashToken(token)))
    .limit(1);
  return row?.organizationId ?? null;
}

export async function hasWorkspace(): Promise<boolean> {
  const [row] = await db.select({ id: leopileWorkspaces.id }).from(leopileWorkspaces).where(inOrg(leopileWorkspaces)).limit(1);
  return Boolean(row);
}

/** Issues (or replaces) this organization's access token. Returned once; only its hash is stored. */
export async function issueAccessToken(): Promise<string> {
  const { accessToken, tokenHash } = newAccessToken();
  await db
    .insert(leopileWorkspaces)
    .values({ organizationId: currentOrganizationId(), tokenHash })
    .onConflictDoUpdate({ target: leopileWorkspaces.organizationId, set: { tokenHash } });
  return accessToken;
}

export const listAccounts = (): Promise<LeopileAccount[]> => db.select().from(leopileAccounts).where(inOrg(leopileAccounts));

export async function findAccount(id: string): Promise<LeopileAccount | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db.select().from(leopileAccounts).where(and(inOrg(leopileAccounts), eq(leopileAccounts.id, id))).limit(1);
  return row ?? null;
}

export const sessionOf = (account: LeopileAccount): LinkedinSession => {
  const { liAt, jsessionid } = decryptIntegrationCredentials(account.encryptedSession);
  return { liAt: liAt!, jsessionid: jsessionid! };
};

/** Runs `fn` with the account's session; LinkedIn refusing the cookies marks the account disconnected. */
export async function withSession<T>(account: LeopileAccount, fn: (session: LinkedinSession) => Promise<T>): Promise<T> {
  try {
    return await fn(sessionOf(account));
  } catch (error) {
    if (error instanceof LinkedinAuthError) {
      await db.update(leopileAccounts).set({ status: "CREDENTIALS" }).where(and(inOrg(leopileAccounts), eq(leopileAccounts.id, account.id)));
    }
    throw error;
  }
}

/** Connects a LinkedIn account from its cookies — or refreshes them when it is already connected. */
export async function connectAccount(liAt: string, jsessionid?: string): Promise<LeopileAccount> {
  if (!liAt.trim()) throw new Error("The li_at cookie is required");
  const session = sessionFrom(liAt, jsessionid);
  const profile = await me(session); // also proves the cookies work
  const encryptedSession = encryptIntegrationCredentials({ liAt: session.liAt, jsessionid: session.jsessionid });
  const [row] = await db
    .insert(leopileAccounts)
    .values({ organizationId: currentOrganizationId(), name: profile.name, publicIdentifier: profile.publicIdentifier, memberId: profile.memberId, encryptedSession })
    .onConflictDoUpdate({
      target: [leopileAccounts.organizationId, leopileAccounts.memberId],
      set: { name: profile.name, publicIdentifier: profile.publicIdentifier, encryptedSession, status: "OK" },
    })
    .returning();
  return row!;
}

export async function removeAccount(id: string): Promise<void> {
  await db.delete(leopileAccounts).where(and(inOrg(leopileAccounts), eq(leopileAccounts.id, id)));
}
