/**
 * Adds the exact trigger time to LinkedIn campaigns ("Campaign"). Matches
 * src/lib/linkedin/schema.ts.
 *
 * - "triggerAt"   when the campaign first runs (default now() + 30 minutes)
 * - "triggeredAt" when it actually first ran; null = not yet. Until it is set,
 *   the regular outreach cron leaves the campaign's leads alone; the
 *   linkedin-trigger-campaigns scheduler job claims it at "triggerAt".
 *
 * Run with:  bun run scripts/add-linkedin-campaign-trigger-time.ts
 *
 * Re-runnable: columns are ADD COLUMN IF NOT EXISTS and the backfill only
 * touches rows still null. Existing campaigns are left untriggered on purpose:
 * the trigger job runs each once (their "triggerAt" is long past), which is
 * harmless because outreach is idempotent.
 */
import { Client } from "pg";

const STATEMENTS = [
  `ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "triggerAt" timestamp(3)`,
  `ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "triggeredAt" timestamp(3)`,
  `UPDATE "Campaign" SET "triggerAt" = "createdAt" + interval '30 minutes' WHERE "triggerAt" IS NULL`,
  `ALTER TABLE "Campaign" ALTER COLUMN "triggerAt" SET DEFAULT (CURRENT_TIMESTAMP + interval '30 minutes')`,
  `ALTER TABLE "Campaign" ALTER COLUMN "triggerAt" SET NOT NULL`,
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
    console.log("Campaign trigger columns ready");
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
