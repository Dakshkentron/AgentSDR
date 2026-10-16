import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";

/**
 * An organization's Leopile workspace: the access token AgentSDR's Unipile
 * integration presents to /api/leopile. Only the token's hash is kept. Built
 * by scripts/create-leopile-tables.ts; scoped in src/lib/tenancy/registry.ts.
 * The token hash is looked up outside any organization scope — it is how the
 * API finds the organization.
 */
export const leopileWorkspaces = pgTable(
  "leopile_workspaces",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("leopile_workspaces_organization_uq").on(table.organizationId),
    uniqueIndex("leopile_workspaces_token_hash_uq").on(table.tokenHash),
  ],
);

/**
 * A LinkedIn account connected to Leopile by its session cookies, which are
 * stored encrypted (encryptIntegrationCredentials of { liAt, jsessionid }).
 * `id` is what Unipile calls the account id — AgentSDR keeps it as
 * LinkedInAccount.linkedinId.
 */
export const leopileAccounts = pgTable(
  "leopile_accounts",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** The /in/<slug> of the account's own profile. */
    publicIdentifier: text("public_identifier").notNull(),
    /** The account's own LinkedIn member id (the ACoAA… provider id). */
    memberId: text("member_id").notNull(),
    encryptedSession: text("encrypted_session").notNull(),
    /** OK, or CREDENTIALS once LinkedIn refuses the cookies. */
    status: text("status").notNull().default("OK"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("leopile_accounts_organization_idx").on(table.organizationId),
    uniqueIndex("leopile_accounts_org_member_uq").on(table.organizationId, table.memberId),
  ],
);
