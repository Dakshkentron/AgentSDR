import { isPlatformConnected } from "@/lib/platform/credentials";
import { and, asc, eq, inArray, ne, count as sqlCount } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobRuns, linkedInAccounts, searchBatches, searchQueries, searchResults } from "@/lib/linkedin/schema";
import { getProfile, searchLinkedIn } from "@/services/unipile.service";
import { inferLinkedinApi, normalizeLinkedinSourceIdentifier, type LinkedinApiHint } from "@/lib/leads/identity";
import { getSearchUsage } from "@/lib/linkedin/searchLeadLimit";
import { incrementSearchLeadsToday } from "@/lib/linkedin/searchLeadLimit.server";
import { selectBestAccount } from "@/lib/linkedin/searchAccountPicker";
import { channelRules } from "@/lib/channels/rules.server";
import { serializeError } from "@/lib/linkedin/serializeError";
import type { LinkedInAccount, SearchQuery, SearchQueryStatus } from "@/lib/linkedin/schema";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { inOrg, maybeCurrentOrganizationId, runInOrganization } from "@/lib/tenancy/scope";
import { unipileOrganizationIds } from "@/lib/linkedin/organizations.server";

const MIN_PAGE_DELAY_MS = 3_000;
const MAX_PAGE_DELAY_MS = 7_000;

// How many searches to work on at once: one per usable account, so every account the
// user picked is busy at the same time. An account is never claimed by two workers
// (see claimAccount), so this can't exceed the accounts available, and there is no
// point starting more workers than there are queries.
const concurrencyFor = (accountCount: number, queryCount: number) =>
  Math.max(1, Math.min(accountCount, queryCount));

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

type RawItem = Record<string, unknown>;

const resolveProfileIdentifier = (item: RawItem): string | null => {
  const id = item.id as string | undefined;
  const prof = item.profile_url as string | undefined;
  const ident = item.public_identifier as string | undefined;
  const pub = item.public_profile_url as string | undefined;
  return normalizeLinkedinSourceIdentifier(id ?? prof ?? ident ?? pub);
};

const mapResults = (searchQueryId: string, items: RawItem[], sourceLinkedinApi: LinkedinApiHint | null) =>
  items
    .map((item) => {
      const linkedinUrl = resolveProfileIdentifier(item);
      if (!linkedinUrl) return null;
      return {
        searchQueryId,
        linkedinUrl,
        sourceLinkedinApi,
        name: (item.name as string) ?? null,
        headline: (item.headline as string) ?? null,
        location: (item.location as string) ?? null,
        profilePictureUrl: (item.profile_picture_url as string) ?? null,
        networkDistance: (item.network_distance as string) ?? null,
        followersCount: (item.followers_count as number) ?? null,
        sharedConnectionsCount: (item.shared_connections_count as number) ?? null,
        raw: JSON.parse(JSON.stringify(item)),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

// A pasted single-profile link ("linkedin.com/in/jane-doe"), not a search-results URL —
// Unipile's search endpoint returns nothing for one of these, so it needs the profile
// lookup endpoint instead. toSearchUrl() already turns any bare name/keywords into a
// real .../search/results/people/?keywords= URL before a query reaches this file, so
// the only way `url` lands here matching this is a URL the user pasted directly.
const PROFILE_URL_RE = /linkedin\.com\/in\/[^/?#]+/i;
const isProfileUrl = (url: string) => PROFILE_URL_RE.test(url);

const runProfileLookupQuery = async (
  queryId: string,
  url: string,
  account: LinkedInAccount,
  pool: AccountPool
): Promise<void> => {
  try {
    const profile = await getProfile(url, account.linkedinId);
    const raw = profile.leadData as Record<string, unknown>;
    await db
      .insert(searchResults)
      .values({
        searchQueryId: queryId,
        linkedinUrl: profile.providerId,
        sourceLinkedinApi: null,
        name: [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null,
        headline: profile.headline || null,
        location: profile.location,
        profilePictureUrl: profile.profilePictureUrl,
        networkDistance: typeof raw.network_distance === "string" ? raw.network_distance : null,
        followersCount: null,
        sharedConnectionsCount: null,
        raw: JSON.parse(JSON.stringify(raw)),
      })
      .onConflictDoNothing();

    const usage = await incrementSearchLeadsToday(account.linkedinId, 1);
    recordUsage(pool, account.id, usage.used);
    await db
      .update(searchQueries)
      .set({ status: "COMPLETED", completedAt: new Date(), leadsFetched: 1, totalCount: 1, cursor: null })
      .where(eq(searchQueries.id, queryId));
    console.log(`[runSearchQueue] "${url}" resolved as a single profile`);
  } catch (err) {
    console.error(`[runSearchQueue] Profile lookup failed for "${url}": ${serializeError(err)}`);
    await db
      .update(searchQueries)
      .set({ status: "FAILED", lastError: serializeError(err) })
      .where(eq(searchQueries.id, queryId));
  } finally {
    releaseAccount(pool, account.id);
  }
};

const getStatus = async (queryId: string): Promise<SearchQueryStatus | null> => {
  const [row] = await db
    .select({ status: searchQueries.status })
    .from(searchQueries)
    .where(eq(searchQueries.id, queryId))
    .limit(1);
  return row?.status ?? null;
};

/**
 * Shared, in-run account bookkeeping. `accountsById` is a local snapshot of every
 * connected account's searchLeadsToday, mutated as quota is spent — selection reads and
 * claims happen synchronously against it (see selectBestAccount), so two concurrent
 * workers can never both land on the same account before either has claimed it.
 */
type AccountPool = {
  accountsById: Map<string, LinkedInAccount>;
  exhausted: Set<string>;
  claimed: Set<string>;
  /** Account ids most-preferred first, as the user arranged them for this search. */
  order: string[];
  /** Leads per account per day (Settings → LinkedIn → Sending rules). */
  dailyLimit: number;
};

const excludeList = (pool: AccountPool): Set<string> => new Set([...pool.exhausted, ...pool.claimed]);

const claimAccount = (pool: AccountPool, excludeIds: Set<string>, minRemaining = 0): LinkedInAccount | null => {
  const picked = selectBestAccount([...pool.accountsById.values()], excludeIds, minRemaining, pool.order, pool.dailyLimit);
  if (picked) pool.claimed.add(picked.id);
  return picked;
};

const releaseAccount = (pool: AccountPool, accountId: string): void => {
  pool.claimed.delete(accountId);
};

const recordUsage = (pool: AccountPool, accountId: string, used: number): void => {
  const cached = pool.accountsById.get(accountId);
  if (cached) cached.searchLeadsToday = used;
};

const runOneQuery = async (
  queryId: string,
  url: string,
  startAccount: LinkedInAccount,
  pool: AccountPool,
  initialCursor: string | null
): Promise<void> => {
  let account = startAccount;
  let cursor: string | undefined = initialCursor ?? undefined;

  try {
    while (true) {
      const status = await getStatus(queryId);
      if (status === "CANCELLED") {
        console.log(`[runSearchQueue] "${url}" was cancelled — stopping`);
        return;
      }

      const isFirstPageForAccount = cursor === undefined;

      let result;
      try {
        result = await searchLinkedIn(account.linkedinId, url, cursor);
      } catch (err) {
        console.error(`[runSearchQueue] Search failed for "${url}": ${serializeError(err)}`);
        await db
          .update(searchQueries)
          .set({ status: "FAILED", lastError: serializeError(err) })
          .where(eq(searchQueries.id, queryId));
        return;
      }

      const items = (result.items ?? []) as RawItem[];
      const mapped = mapResults(queryId, items, inferLinkedinApi(url));
      if (mapped.length > 0) {
        await db.insert(searchResults).values(mapped).onConflictDoNothing();
      }

      const usage = await incrementSearchLeadsToday(account.linkedinId, items.length);
      recordUsage(pool, account.id, usage.used);
      const [{ n: leadsFetched }] = await db
        .select({ n: sqlCount() })
        .from(searchResults)
        .where(eq(searchResults.searchQueryId, queryId));
      const totalCount = result.paging?.total_count;
      cursor = result.cursor ?? undefined;

      await db
        .update(searchQueries)
        .set({
          cursor: cursor ?? null,
          // `undefined` is omitted from the SET, matching Prisma's behaviour of
          // leaving the column untouched when total_count is absent.
          ...(totalCount === undefined ? {} : { totalCount }),
          leadsFetched,
        })
        .where(eq(searchQueries.id, queryId));

      if (!cursor) {
        // Unipile stops handing back a cursor once it has nothing more to page through —
        // that's the only authoritative "done" signal. The total_count LinkedIn reports up
        // front is frequently just an estimate, so leadsFetched landing short of it (or
        // exactly on it) doesn't mean anything on its own; only a missing cursor does.
        console.log(`[runSearchQueue] "${url}" complete — ${leadsFetched} lead(s) fetched`);
        await db
          .update(searchQueries)
          .set({ status: "COMPLETED", completedAt: new Date() })
          .where(eq(searchQueries.id, queryId));
        return;
      }

      // Proactively move to an account that can actually finish this search, rather than
      // grinding partway on one that can't and paying a full from-scratch restart later.
      // total_count is only known once the first page comes back, so right after that page
      // is the earliest this call can be made — best-effort, not a guarantee: LinkedIn's
      // reported total is often approximate, and no account may have enough headroom at all.
      if (isFirstPageForAccount && typeof totalCount === "number") {
        const stillNeeded = totalCount - leadsFetched;
        const remainingOnThisAccount = getSearchUsage(usage.used, pool.dailyLimit).remaining;
        if (stillNeeded > remainingOnThisAccount) {
          const capable = claimAccount(pool, new Set([account.id, ...excludeList(pool)]), stillNeeded);
          if (capable) {
            console.log(
              `[runSearchQueue] "${url}" needs ~${stillNeeded} more but @${account.username} only has ${remainingOnThisAccount} left — moving to @${capable.username} before continuing`
            );
            releaseAccount(pool, account.id);
            account = capable;
            cursor = undefined;
            await db
              .update(searchQueries)
              .set({ currentAccountId: account.id, cursor: null })
              .where(eq(searchQueries.id, queryId));
            await sleep(randomInt(MIN_PAGE_DELAY_MS, MAX_PAGE_DELAY_MS));
            continue;
          }
        }
      }

      if (usage.limitReached) {
        pool.exhausted.add(account.id);
        console.warn(`[runSearchQueue] @${account.username} hit its daily search quota — looking for another account`);
        const next = claimAccount(pool, excludeList(pool));
        if (!next) {
          console.warn(`[runSearchQueue] No connected account has remaining search quota — pausing "${url}"`);
          await db
            .update(searchQueries)
            .set({ status: "PAUSED_LIMIT" })
            .where(eq(searchQueries.id, queryId));
          return;
        }
        releaseAccount(pool, account.id);
        account = next;
        // Unipile's cursor is scoped to the account that started the search session, so
        // resume the new account from page 1. skipDuplicates on [searchQueryId, linkedinUrl]
        // means leads already stored won't be duplicated.
        cursor = undefined;
        await db
          .update(searchQueries)
          .set({ currentAccountId: account.id, cursor: null })
          .where(eq(searchQueries.id, queryId));
        console.log(`[runSearchQueue] Switched "${url}" to @${account.username}`);
      }

      await sleep(randomInt(MIN_PAGE_DELAY_MS, MAX_PAGE_DELAY_MS));
    }
  } finally {
    releaseAccount(pool, account.id);
  }
};

const processQuery = async (query: SearchQuery, pool: AccountPool): Promise<void> => {
  console.log(`[runSearchQueue] ── "${query.url}" ──`);

  // Re-check against the DB rather than trusting the snapshot taken at the top of this
  // run — belt-and-suspenders alongside the single-run guard in runSearchQueue.
  const currentStatus = await getStatus(query.id);
  if (currentStatus !== "QUEUED" && currentStatus !== "RUNNING" && currentStatus !== "PAUSED_LIMIT") {
    console.log(`[runSearchQueue] "${query.url}" is already ${currentStatus ?? "removed"} — skipping`);
    return;
  }

  // If the account this query last used is still connected, unclaimed, and has quota, keep
  // going from its saved cursor. Otherwise a different account has to pick it up, and
  // pagination restarts from page 1 (see the cursor note in runOneQuery).
  const lastAccount = query.currentAccountId ? pool.accountsById.get(query.currentAccountId) : undefined;

  let account: LinkedInAccount | null = null;
  let resumeCursor: string | null = null;

  if (
    lastAccount &&
    !pool.exhausted.has(lastAccount.id) &&
    !pool.claimed.has(lastAccount.id) &&
    !getSearchUsage(lastAccount.searchLeadsToday, pool.dailyLimit).limitReached
  ) {
    pool.claimed.add(lastAccount.id);
    account = lastAccount;
    resumeCursor = query.cursor;
  } else {
    account = claimAccount(pool, excludeList(pool));
  }

  if (!account) {
    console.warn(`[runSearchQueue] No connected account has remaining search quota — pausing "${query.url}"`);
    await db
      .update(searchQueries)
      .set({ status: "PAUSED_LIMIT" })
      .where(eq(searchQueries.id, query.id));
    return;
  }

  await db
    .update(searchQueries)
    .set({
      status: "RUNNING",
      currentAccountId: account.id,
      startedAt: query.startedAt ?? new Date(),
      cursor: resumeCursor,
    })
    .where(eq(searchQueries.id, query.id));

  if (isProfileUrl(query.url)) {
    await runProfileLookupQuery(query.id, query.url, account, pool);
    return;
  }

  await runOneQuery(query.id, query.url, account, pool, resumeCursor);
};

export type RunSearchQueueOptions = {
  /**
   * Restrict this run to these account ids. Undefined means every connected account is
   * fair game (the historical behaviour). A query that last ran on an account outside
   * this set is picked up by one inside it, restarting from page 1 like any other
   * account switch.
   */
  accountIds?: string[];
  /** Only run the queries in this batch. Undefined means every runnable query. */
  batchId?: string;
  /** Narrow further to these specific queries — used by "rerun selected". */
  queryIds?: string[];
};

export const runSearchQueue = async (runId?: string, options: RunSearchQueueOptions = {}): Promise<void> => {
  console.log("[runSearchQueue] Starting");

  if (isMigrationControlPaused("linkedinSearch")) {
    console.warn("[runSearchQueue] LinkedIn search processing is paused; job skipped");
    return;
  }

  // Only one run-search-queue execution may touch the queue at a time — two overlapping
  // runs each hold their own stale snapshot of query statuses, so a slower run can finish
  // an iteration *after* a faster run already completed that same query and clobber its
  // COMPLETED status back to PAUSED_LIMIT. Bail out rather than race.
  const [alreadyRunning] = await db
    .select({ id: jobRuns.id })
    .from(jobRuns)
    .where(
      and(
        eq(jobRuns.job, "run-search-queue"),
        eq(jobRuns.status, "RUNNING"),
        ...(runId ? [ne(jobRuns.id, runId)] : [])
      )
    )
    .limit(1);
  if (alreadyRunning) {
    console.warn("[runSearchQueue] Another run is already in progress — skipping to avoid clobbering its progress");
    return;
  }

  // Inside an organization scope (a signed-in caller) only that organization's
  // queue runs; the cron run walks every organization that has Unipile connected,
  // each in its own scope.
  if (maybeCurrentOrganizationId()) {
    await runOrganizationQueue(options);
  } else {
    for (const organizationId of await unipileOrganizationIds()) {
      try {
        await runInOrganization(organizationId, () => runOrganizationQueue(options));
      } catch (err) {
        console.error(`[runSearchQueue] Organization ${organizationId} failed: ${serializeError(err)}`);
      }
    }
  }

  console.log("[runSearchQueue] Job complete");
};

const runOrganizationQueue = async (options: RunSearchQueueOptions): Promise<void> => {
  if (!(await isPlatformConnected("unipile"))) {
    console.log("[runSearchQueue] Unipile is not connected — skipping");
    return;
  }

  // SearchQuery belongs to the organization of its SearchBatch.
  const queries = await db
    .select()
    .from(searchQueries)
    .where(
      and(
        inArray(searchQueries.batchId, db.select({ id: searchBatches.id }).from(searchBatches).where(inOrg(searchBatches))),
        inArray(searchQueries.status, ["QUEUED", "RUNNING", "PAUSED_LIMIT"]),
        ...(options.batchId ? [eq(searchQueries.batchId, options.batchId)] : []),
        ...(options.queryIds?.length ? [inArray(searchQueries.id, options.queryIds)] : [])
      )
    )
    .orderBy(asc(searchQueries.createdAt));

  if (queries.length === 0) {
    console.log("[runSearchQueue] Nothing queued, stopping");
    return;
  }

  const order = options.accountIds ?? [];
  const allowed = order.length > 0 ? new Set(order) : null;
  const accounts = (
    await db
      .select()
      .from(linkedInAccounts)
      .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.status, "CONNECTED")))
  ).filter((a) => !allowed || allowed.has(a.id));

  if (allowed) {
    if (accounts.length === 0) {
      console.warn("[runSearchQueue] None of the selected accounts are connected — nothing to run with");
      return;
    }
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const inOrder = order.map((id) => byId.get(id)).filter((a): a is LinkedInAccount => Boolean(a));
    console.log(`[runSearchQueue] Using, in order: ${inOrder.map((a) => `@${a.username}`).join(", ")}`);
  }

  const pool: AccountPool = {
    accountsById: new Map(accounts.map((a) => [a.id, a])),
    exhausted: new Set(),
    claimed: new Set(),
    order,
    dailyLimit: (await channelRules("linkedin")).searchLeadsPerDay,
  };

  const concurrency = concurrencyFor(accounts.length, queries.length);
  console.log(
    `[runSearchQueue] ${queries.length} search(es) to run across ${accounts.length} account(s), ${concurrency} at a time`
  );

  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < queries.length) {
      const query = queries[nextIndex++];
      await processQuery(query, pool);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
};
