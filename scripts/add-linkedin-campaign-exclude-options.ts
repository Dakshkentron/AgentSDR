/**
 * Adds the HeyReach-style "Exclude options" to LinkedIn campaigns
 * ("Campaign"). Matches src/lib/linkedin/schema.ts.
 *
 * Run with:  bun run scripts/add-linkedin-campaign-exclude-options.ts
 *
 * Re-runnable: every column is ADD COLUMN IF NOT EXISTS with a default, so
 * existing campaigns get the same defaults as new ones.
 */
import { Client } from "pg";

const STATEMENTS = [
  `ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "excludeBlacklisted" boolean NOT NULL DEFAULT true`,
  `ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "excludeBlacklistedCompanies" boolean NOT NULL DEFAULT true`,
  `ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "excludeContactedBySameSender" boolean NOT NULL DEFAULT false`,
  `ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "excludeContactedOtherCampaigns" boolean NOT NULL DEFAULT false`,
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set — check .env.local");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("SET lock_timeout = '5s'");
    await client.query("BEGIN");
    for (const statement of STATEMENTS) await client.query(statement);
    await client.query("COMMIT");
    console.log("Campaign exclude columns ready");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
