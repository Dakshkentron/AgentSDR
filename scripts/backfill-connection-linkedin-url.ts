/**
 * Fills "Connection"."linkedinUrl" from the person's linked Lead/Person slug or,
 * failing that, the member id in "providerId" (LinkedIn resolves
 * https://www.linkedin.com/in/<ACoAA…>/ to the profile). Full URLs match what
 * message sync and the connection-accepted webhook store.
 *
 * Run with:  bun run scripts/backfill-connection-linkedin-url.ts
 *
 * Re-runnable: only rows whose linkedinUrl is NULL or empty are touched, and
 * a stored value is never replaced. Organization-agnostic on purpose — each
 * row keeps its own organization; nothing crosses tenants.
 */
import { Client } from "pg";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set — check .env.local");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const fromPerson = await client.query(`
      UPDATE "Connection" c
      SET "linkedinUrl" = p.linkedin_url
      FROM "Lead" l JOIN people p ON p.id = l."personId" AND p.organization_id = l."organizationId"
      WHERE l.id = c."leadId" AND l."organizationId" = c."organizationId"
        AND COALESCE(c."linkedinUrl", '') = '' AND COALESCE(p.linkedin_url, '') <> ''`);
    const fromProvider = await client.query(`
      UPDATE "Connection"
      SET "linkedinUrl" = 'https://www.linkedin.com/in/' || "providerId" || '/'
      WHERE COALESCE("linkedinUrl", '') = '' AND "providerId" ~ '^AC[A-Za-z0-9_-]{20,}$'`);
    console.log(`Filled ${fromPerson.rowCount} from Person slugs, ${fromProvider.rowCount} from member ids.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
