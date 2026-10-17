import "server-only";

import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { slugify } from "./slug";
import { invitations, members, organizations, users } from "./schema";
import { mayCreateOrganization } from "./signup";

/**
 * Creates the one organization of a person who belongs to none, named after
 * them, with them as owner, and returns its id. Runs as their session is
 * created (email or Google), so they land in the app with nothing to fill
 * in. Returns null when they should not get one: someone invited joins the
 * inviting organization instead, and invite-only instances keep their rule.
 */
export async function createOwnOrganization(userId: string): Promise<string | null> {
  const [user] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return null;
  const [invited] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(and(sql`lower(${invitations.email}) = ${user.email.toLowerCase()}`, eq(invitations.status, "pending"), gt(invitations.expiresAt, new Date())))
    .limit(1);
  if (invited || !(await mayCreateOrganization(userId))) return null;

  const name = user.name?.trim() || user.email.split("@")[0];
  // A short random suffix keeps the URL name unique without asking for one.
  const slug = `${slugify(name) || "workspace"}-${crypto.randomUUID().slice(0, 6)}`;
  return db.transaction(async (tx) => {
    const [organization] = await tx.insert(organizations).values({ name, slug }).returning({ id: organizations.id });
    await tx.insert(members).values({ organizationId: organization.id, userId, role: "owner" });
    return organization.id;
  });
}
