/**
 * Creates leopile_workspaces and leopile_accounts — Leopile, the
 * Unipile-compatible LinkedIn provider hosted in this app. Matches
 * src/lib/leopile/schema.ts.
 *
 * Run with:  bun run scripts/create-leopile-tables.ts
 *
 * New tables only. Re-runnable: every table and index is guarded.
 */
import { Client } from "pg";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS leopile_workspaces (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     token_hash text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS leopile_workspaces_organization_uq ON leopile_workspaces (organization_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS leopile_workspaces_token_hash_uq ON leopile_workspaces (token_hash)`,
  `CREATE TABLE IF NOT EXISTS leopile_accounts (
     organization_id uuid NOT NULL REFERENCES organizations(id),
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     name text NOT NULL,
     public_identifier text NOT NULL,
     member_id text NOT NULL,
     encrypted_session text NOT NULL,
     status text NOT NULL DEFAULT 'OK',
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS leopile_accounts_organization_idx ON leopile_accounts (organization_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS leopile_accounts_org_member_uq ON leopile_accounts (organization_id, member_id)`,
];

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const statement of STATEMENTS) await client.query(statement);
    console.log("leopile tables ready");
  } finally {
    await client.end();
  }
}

await main();
