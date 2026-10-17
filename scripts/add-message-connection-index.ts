/**
 * Indexes "Message" by conversation. The LinkedIn Messages list (and its
 * "Needs reply" / "Replied" filters) looks up each connection's newest
 * message; with no "connectionId" index every lookup scanned the whole
 * table, once per connection, which took the list to 5-10 s and more.
 * Matches src/lib/linkedin/schema.ts.
 *
 * Run with:  bun run scripts/add-message-connection-index.ts
 *
 * Re-runnable (IF NOT EXISTS). CONCURRENTLY, so writes are not blocked while
 * it builds; that also means it cannot run inside a transaction.
 */
import { Client } from "pg";

const STATEMENT = `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_connection_latest_idx"
  ON "Message" ("connectionId", "createdAt" DESC, "id" DESC)
  WHERE "duplicateOfMessageId" IS NULL`;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set — check .env.local");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query(STATEMENT);
    console.log("Message_connection_latest_idx ready");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
