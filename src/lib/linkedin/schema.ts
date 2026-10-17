/**
 * Drizzle definitions for the LinkedIn tables, replacing the Prisma client.
 *
 * These tables were created by Prisma migrations and hold live production
 * data (18k leads, 26k messages). This file MIRRORS what already exists —
 * it is not a source of truth for DDL and must never be used to generate or
 * push schema changes. Every name, type, nullability and default here was
 * read back off the live database with information_schema, not transcribed
 * from schema.prisma, because the two had already drifted: the LeadStatus
 * and MessageType enums have FOLLOW_UP_3* / COMPLETED appended at the end
 * in the database, while schema.prisma lists them mid-enum. Postgres enum
 * order is part of the type, so the order below is the database's.
 *
 * Identifiers are quoted PascalCase/camelCase, unlike the snake_case tables
 * the rest of this app owns. That is Prisma's convention and the live tables
 * are named that way; Drizzle quotes them automatically.
 *
 * These tables are deliberately NOT in drizzle.config.ts's OWNED_TABLES.
 * Keeping them out means drizzle-kit will not try to manage or diff them, so
 * there is no path by which `drizzle-kit push` could alter live LinkedIn
 * data. Changing that is a separate, deliberate decision.
 *
 * ## Why these ids are `text` + $defaultFn, not `uuid().defaultRandom()`
 *
 * Everywhere else in this app, Drizzle tables use the idiomatic
 * `uuid("id").primaryKey().defaultRandom()` — Postgres generates the value
 * and no library is involved. That is the right default and these tables
 * would use it too if they were new.
 *
 * They are not new. Prisma created them with `@default(cuid())`, which it
 * applies *client-side*, so the live columns are `text` with **no database
 * default**, holding 18k+ existing 25-character cuids. Moving to
 * `uuid().defaultRandom()` would mean ALTER TYPE on every id and foreign key
 * across Lead / Message / Connection / SearchResult — rewriting live
 * production data. Not worth it to change an id format.
 *
 * So the column type mirrors what exists, and generation uses `$defaultFn`,
 * which is Drizzle's own hook for exactly this case. The generator is
 * `@paralleldrive/cuid2` (the maintained successor to the `cuid` package
 * Prisma used) rather than anything hand-rolled. New ids are cuid2 and will
 * look different from the old cuid v1 ones; that is fine — nothing in this
 * codebase parses, validates, or sorts by id (all ordering is on timestamp
 * columns), and both are collision-resistant lowercase alphanumerics in a
 * `text` column.
 */

import { createId } from "@paralleldrive/cuid2";
import { people } from "@/lib/leads/schema";
import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";

/* -------------------------------------------------------------------------
 * Enums — order matches the live database (see note above).
 * ---------------------------------------------------------------------- */

export const accountStatusEnum = pgEnum("AccountStatus", ["CONNECTED", "DISCONNECTED"]);

export const campaignStatusEnum = pgEnum("CampaignStatus", ["ACTIVE", "PAUSED"]);

export const campaignTypeEnum = pgEnum("CampaignType", ["REGULAR", "PERSONAL"]);

export const leadStatusEnum = pgEnum("LeadStatus", [
  "PENDING",
  "REQUEST_SENT",
  "CONNECTED",
  "ACCEPT_MESSAGE_SENT",
  "FOLLOW_UP_1_SENT",
  "FOLLOW_UP_2_SENT",
  "REPLIED",
  "FAILED",
  "FOLLOW_UP_3_SENT",
  "COMPLETED",
  "CANCELLED",
]);

export const messageTypeEnum = pgEnum("MessageType", [
  "INVITATION",
  "ACCEPTANCE",
  "FOLLOW_UP_1",
  "FOLLOW_UP_2",
  "RECEIVED",
  "CUSTOM_SENT",
  "FOLLOW_UP_3",
]);

export const searchQueryStatusEnum = pgEnum("SearchQueryStatus", [
  "QUEUED",
  "RUNNING",
  "PAUSED_LIMIT",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export const searchBatchKindEnum = pgEnum("SearchBatchKind", ["SINGLE", "BULK"]);

/* -------------------------------------------------------------------------
 * Tables
 *
 * `updatedAt` carries no database default — Prisma's @updatedAt is applied
 * client-side. `$onUpdate` reproduces that, and the inserts in this codebase
 * set it explicitly; a raw INSERT that omits it would violate NOT NULL.
 * ---------------------------------------------------------------------- */

export const linkedInAccounts = pgTable("LinkedInAccount", {
  organizationId: uuid("organizationId")
    .notNull()
    .references(() => organizations.id),
  id: text("id").primaryKey().$defaultFn(createId),
  linkedinId: text("linkedinId").notNull().unique(),
  username: text("username").notNull(),
  name: text("name"),
  profilePictureUrl: text("profilePictureUrl"),
  headline: text("headline"),
  profileData: jsonb("profileData"),
  status: accountStatusEnum("status").notNull().default("CONNECTED"),
  limitReached: boolean("limitReached").notNull().default(false),
  searchLeadsToday: integer("searchLeadsToday").notNull().default(0),
  isPremium: boolean("isPremium").notNull().default(false),
  /** Invitations a day for this account; null = the organization's rule for its tier (Settings → LinkedIn → Sending rules). */
  dailyInviteLimit: integer("dailyInviteLimit"),
  workTimezone: text("workTimezone"),
  workStartTime: text("workStartTime"),
  workEndTime: text("workEndTime"),
  workDays: text("workDays"),
  nextAllowedRun: timestamp("nextAllowedRun", { precision: 3, mode: "date" }),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { precision: 3, mode: "date" })
    .notNull()
    .$onUpdate(() => new Date()),
},
  (t) => [index("LinkedInAccount_organization_idx").on(t.organizationId)],
);

/** A new (or newly launched) campaign first runs this long after. */
export const CAMPAIGN_TRIGGER_DELAY_MS = 30 * 60 * 1000;
export const campaignTriggerAt = (from = new Date()): Date => new Date(from.getTime() + CAMPAIGN_TRIGGER_DELAY_MS);

export const campaigns = pgTable("Campaign", {
  organizationId: uuid("organizationId")
    .notNull()
    .references(() => organizations.id),
  id: text("id").primaryKey().$defaultFn(createId),
  name: text("name").notNull(),
  description: text("description"),
  status: campaignStatusEnum("status").notNull().default("ACTIVE"),
  type: campaignTypeEnum("type").notNull().default("REGULAR"),
  invitationMessage: text("invitationMessage"),
  acceptanceMessage: text("acceptanceMessage"),
  followUp1Message: text("followUp1Message"),
  followUp2Message: text("followUp2Message"),
  followUp3Message: text("followUp3Message"),
  /** Exclude options (scripts/add-linkedin-campaign-exclude-options.ts). */
  excludeBlacklisted: boolean("excludeBlacklisted").notNull().default(true),
  excludeBlacklistedCompanies: boolean("excludeBlacklistedCompanies").notNull().default(true),
  excludeContactedBySameSender: boolean("excludeContactedBySameSender").notNull().default(false),
  excludeContactedOtherCampaigns: boolean("excludeContactedOtherCampaigns").notNull().default(false),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { precision: 3, mode: "date" })
    .notNull()
    .$onUpdate(() => new Date()),
  /** When the campaign first runs (scripts/add-linkedin-campaign-trigger-time.ts). Reset to now + 30 min at launch. */
  triggerAt: timestamp("triggerAt", { precision: 3, mode: "date" }).notNull().$defaultFn(campaignTriggerAt),
  /** When it actually first ran; null = not yet, and the outreach cron leaves its leads alone. */
  triggeredAt: timestamp("triggeredAt", { precision: 3, mode: "date" }),
},
  (t) => [index("Campaign_organization_idx").on(t.organizationId)],
);

export const campaignAccounts = pgTable(
  "CampaignAccount",
  {
    campaignId: text("campaignId").notNull(),
    linkedinAccountId: text("linkedinAccountId").notNull(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.linkedinAccountId] })]
);

export const leads = pgTable(
  "Lead",
  {
    organizationId: uuid("organizationId")
      .notNull()
      .references(() => organizations.id),
    id: text("id").primaryKey().$defaultFn(createId),
    /** Person exists before resolution; LinkedIn identity may still be null on that Person. */
    personId: uuid("personId").notNull().references(() => people.id, { onDelete: "restrict" }),
    /** Exact public/provider identifier supplied to Unipile. Cleared after successful resolution. */
    sourceLinkedinIdentifier: text("sourceLinkedinIdentifier"),
    /** Required when the source identifier belongs to Sales Navigator or Recruiter. */
    sourceLinkedinApi: text("sourceLinkedinApi"),
    /** @deprecated Legacy pre-migration snapshot. Workers resolve through personId. */
    linkedinUrl: text("linkedinUrl"),
    providerId: text("providerId"),
    name: text("name"),
    profilePictureUrl: text("profilePictureUrl"),
    headline: text("headline"),
    location: text("location"),
    leadData: jsonb("leadData"),
    status: leadStatusEnum("status").notNull().default("PENDING"),
    inviteRetryCount: integer("inviteRetryCount").notNull().default(0),
    resolveRetryCount: integer("resolveRetryCount").notNull().default(0),
    resolveNextAttemptAt: timestamp("resolveNextAttemptAt", { precision: 3, mode: "date" }),
    resolveLastError: text("resolveLastError"),
    /** Historical enrollment replaced by another Lead for the same provider/account. */
    supersededByLeadId: text("supersededByLeadId"),
    requestSentAt: timestamp("requestSentAt", { precision: 3, mode: "date" }),
    acceptMessageSentAt: timestamp("acceptMessageSentAt", { precision: 3, mode: "date" }),
    campaignId: text("campaignId"),
    invitationMessage: text("invitationMessage"),
    acceptanceMessage: text("acceptanceMessage"),
    followUp1Message: text("followUp1Message"),
    followUp1SentAt: timestamp("followUp1SentAt", { precision: 3, mode: "date" }),
    followUp2Message: text("followUp2Message"),
    followUp2SentAt: timestamp("followUp2SentAt", { precision: 3, mode: "date" }),
    followUp3Message: text("followUp3Message"),
    followUp3SentAt: timestamp("followUp3SentAt", { precision: 3, mode: "date" }),
    linkedinAccountId: text("linkedinAccountId"),
    createdAt: timestamp("createdAt", { precision: 3, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { precision: 3, mode: "date" })
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("Lead_organization_idx").on(t.organizationId),
    uniqueIndex("Lead_personId_campaignId_key").on(t.personId, t.campaignId),
    uniqueIndex("Lead_sourceLinkedinIdentifier_campaignId_key").on(
      t.sourceLinkedinIdentifier,
      sql`coalesce(${t.sourceLinkedinApi}, '')`,
      t.campaignId,
    ),
    index("Lead_unresolvedLinkedin_idx").on(t.sourceLinkedinIdentifier, t.createdAt),
    uniqueIndex("Lead_linkedinUrl_campaignId_key").on(t.linkedinUrl, t.campaignId),
    index("Lead_linkedinUrl_idx").on(t.linkedinUrl),
    index("Lead_providerId_idx").on(t.providerId),
    index("Lead_supersededByLeadId_idx").on(t.supersededByLeadId),
  ]
);

export const connections = pgTable(
  "Connection",
  {
    organizationId: uuid("organizationId")
      .notNull()
      .references(() => organizations.id),
    id: text("id").primaryKey().$defaultFn(createId),
    providerId: text("providerId").notNull(),
    name: text("name"),
    headline: text("headline"),
    profilePictureUrl: text("profilePictureUrl"),
    linkedinUrl: text("linkedinUrl"),
    chatId: text("chatId"),
    leadId: text("leadId").unique(),
    linkedinAccountId: text("linkedinAccountId"),
    connectedAt: timestamp("connectedAt", { precision: 3, mode: "date" }),
    createdAt: timestamp("createdAt", { precision: 3, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { precision: 3, mode: "date" })
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("Connection_organization_idx").on(t.organizationId),
    uniqueIndex("Connection_providerId_linkedinAccountId_key").on(
      t.providerId,
      t.linkedinAccountId
    ),
  ]
);

export const messages = pgTable("Message", {
  organizationId: uuid("organizationId")
    .notNull()
    .references(() => organizations.id),
  id: text("id").primaryKey().$defaultFn(createId),
  type: messageTypeEnum("type").notNull(),
  text: text("text").notNull(),
  linkedinMessageId: text("linkedinMessageId"),
  seen: boolean("seen").notNull().default(false),
  connectionId: text("connectionId"),
  leadId: text("leadId"),
  /** Historical provider-confirmed duplicate; canonical delivery rows stay null. */
  duplicateOfMessageId: text("duplicateOfMessageId"),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" }).notNull().defaultNow(),
}, (t) => [
    index("Message_organization_idx").on(t.organizationId),
  uniqueIndex("Message_automated_lead_type_uq")
    .on(t.leadId, t.type)
    .where(sql`${t.leadId} is not null and ${t.duplicateOfMessageId} is null and ${t.type} in ('INVITATION', 'ACCEPTANCE', 'FOLLOW_UP_1', 'FOLLOW_UP_2', 'FOLLOW_UP_3')`),
  index("Message_leadId_idx").on(t.leadId),
  index("Message_duplicateOfMessageId_idx").on(t.duplicateOfMessageId),
  // scripts/add-message-connection-index.ts — newest message per conversation.
  index("Message_connection_latest_idx")
    .on(t.connectionId, t.createdAt.desc(), t.id.desc())
    .where(sql`${t.duplicateOfMessageId} is null`),
]);

export const jobRuns = pgTable("JobRun", {
  id: text("id").primaryKey().$defaultFn(createId),
  job: text("job").notNull(),
  status: text("status").notNull().default("RUNNING"),
  startedAt: timestamp("startedAt", { precision: 3, mode: "date" }).notNull().defaultNow(),
  finishedAt: timestamp("finishedAt", { precision: 3, mode: "date" }),
  error: text("error"),
});

export const jobLogs = pgTable("JobLog", {
  id: text("id").primaryKey().$defaultFn(createId),
  jobRunId: text("jobRunId").notNull(),
  level: text("level").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" }).notNull().defaultNow(),
});

export const webhookEvents = pgTable("WebhookEvent", {
  organizationId: uuid("organizationId")
    .notNull()
    .references(() => organizations.id),
  id: text("id").primaryKey().$defaultFn(createId),
  /** Stable delivery identity used to collapse provider retries. */
  providerEventKey: text("providerEventKey"),
  event: text("event").notNull(),
  accountType: text("accountType"),
  accountId: text("accountId"),
  senderId: text("senderId"),
  chatId: text("chatId"),
  messageText: text("messageText"),
  rawBody: jsonb("rawBody").notNull(),
  connectionId: text("connectionId"),
  processingLog: jsonb("processingLog"),
  processingStatus: text("processingStatus"),
  processingAttempt: integer("processingAttempt").notNull().default(0),
  processingStartedAt: timestamp("processingStartedAt", { precision: 3, mode: "date" }),
  nextAttemptAt: timestamp("nextAttemptAt", { precision: 3, mode: "date" }),
  processedAt: timestamp("processedAt", { precision: 3, mode: "date" }),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" }).notNull().defaultNow(),
}, (t) => [
    index("WebhookEvent_organization_idx").on(t.organizationId),
  uniqueIndex("WebhookEvent_providerEventKey_uq")
    .on(t.providerEventKey)
    .where(sql`${t.providerEventKey} is not null`),
  index("WebhookEvent_retry_idx").on(t.processingStatus, t.nextAttemptAt, t.createdAt),
]);

/**
 * One "search" as the user sees it — a named group of search URLs run together,
 * the way a campaign groups leads. Created by scripts/create-search-batches.ts,
 * which also folded every pre-existing SearchQuery into one "Earlier searches"
 * batch so `SearchQuery.batchId` could be NOT NULL from the start.
 */
export const searchBatches = pgTable("SearchBatch", {
  organizationId: uuid("organizationId")
    .notNull()
    .references(() => organizations.id),
  id: text("id").primaryKey().$defaultFn(createId),
  name: text("name").notNull(),
  kind: searchBatchKindEnum("kind").notNull().default("BULK"),
  // LinkedIn account ids (LinkedInAccount.id) this batch runs on. Empty means every
  // connected account.
  accountIds: jsonb("accountIds").$type<string[]>().notNull().default([]),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { precision: 3, mode: "date" })
    .notNull()
    .$onUpdate(() => new Date()),
},
  (t) => [index("SearchBatch_organization_idx").on(t.organizationId)],
);

export const searchQueries = pgTable("SearchQuery", {
  id: text("id").primaryKey().$defaultFn(createId),
  batchId: text("batchId")
    .notNull()
    .references(() => searchBatches.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  companyName: text("companyName"),
  status: searchQueryStatusEnum("status").notNull().default("QUEUED"),
  cursor: text("cursor"),
  totalCount: integer("totalCount"),
  leadsFetched: integer("leadsFetched").notNull().default(0),
  lastError: text("lastError"),
  currentAccountId: text("currentAccountId"),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { precision: 3, mode: "date" })
    .notNull()
    .$onUpdate(() => new Date()),
  startedAt: timestamp("startedAt", { precision: 3, mode: "date" }),
  completedAt: timestamp("completedAt", { precision: 3, mode: "date" }),
});

export const searchResults = pgTable(
  "SearchResult",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    searchQueryId: text("searchQueryId").notNull(),
    linkedinUrl: text("linkedinUrl").notNull(),
    sourceLinkedinApi: text("sourceLinkedinApi"),
    name: text("name"),
    headline: text("headline"),
    location: text("location"),
    profilePictureUrl: text("profilePictureUrl"),
    networkDistance: text("networkDistance"),
    followersCount: integer("followersCount"),
    sharedConnectionsCount: integer("sharedConnectionsCount"),
    raw: jsonb("raw"),
    createdAt: timestamp("createdAt", { precision: 3, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("SearchResult_searchQueryId_linkedinUrl_key").on(t.searchQueryId, t.linkedinUrl),
  ]
);

/* -------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------- */

export type LinkedInAccount = typeof linkedInAccounts.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type CampaignAccount = typeof campaignAccounts.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;
export type JobLog = typeof jobLogs.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type SearchBatch = typeof searchBatches.$inferSelect;
export type SearchQuery = typeof searchQueries.$inferSelect;
export type SearchResult = typeof searchResults.$inferSelect;

export type LeadStatus = (typeof leadStatusEnum.enumValues)[number];
export type MessageType = (typeof messageTypeEnum.enumValues)[number];
export type AccountStatus = (typeof accountStatusEnum.enumValues)[number];
export type CampaignStatus = (typeof campaignStatusEnum.enumValues)[number];
export type CampaignType = (typeof campaignTypeEnum.enumValues)[number];
export type SearchQueryStatus = (typeof searchQueryStatusEnum.enumValues)[number];
export type SearchBatchKind = (typeof searchBatchKindEnum.enumValues)[number];
