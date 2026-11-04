import { relations, sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);
export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adapterType: text("adapter_type").notNull(),
    label: text("label").notNull(),
    payload: text("payload").notNull(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("credentials_adapter_label_idx").on(t.adapterType, t.label)],
);

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    niche: text("niche").notNull(),
    area: text("area"),
    notes: text("notes"),
    exclusions: jsonb("exclusions").$type<string[]>().notNull().default([]),
    status: text("status", { enum: ["draft", "active", "paused", "archived"] })
      .notNull()
      .default("draft"),
    dailyLeadGoal: integer("daily_lead_goal").notNull().default(100),
    maxTurnsPerRun: integer("max_turns_per_run"),
    scheduleEnabled: boolean("schedule_enabled").notNull().default(false),
    scheduleIntervalHours: integer("schedule_interval_hours").notNull().default(4),
    sinkConfig: jsonb("sink_config").$type<{ googleSheets?: { spreadsheetId?: string; sheetName?: string } }>().notNull().default({}),
    exportMode: text("export_mode", { enum: ["one_per_company", "all_contacts"] })
      .notNull()
      .default("one_per_company"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("campaigns_user_status_idx").on(t.userId, t.status)],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["queued", "running", "succeeded", "failed", "cancelled", "paused"] }).notNull(),
    trigger: text("trigger", { enum: ["schedule", "manual"] }).notNull(),
    traceId: text("trace_id"),
    turns: integer("turns").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    resumeState: jsonb("resume_state"),
    request: jsonb("request").$type<{
      userId?: string;
      goalNewReadyLeads?: number;
      maxTurns?: number | null;
      resume?: boolean;
    }>(),
    result: jsonb("result").$type<{
      status: string;
      reason?: string;
      turnsUsed: number;
      costUsd?: number;
      newReadyLeads: number;
      totalReadyLeads: number;
      errors?: { stage: string; code: string; message: string }[];
    }>(),
    idempotencyKey: text("idempotency_key"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempt: integer("attempt").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("runs_campaign_started_idx").on(t.campaignId, t.startedAt),
    uniqueIndex("runs_active_campaign_idx")
      .on(t.campaignId)
      .where(sql`status in ('queued', 'running')`),
    uniqueIndex("runs_campaign_idempotency_idx")
      .on(t.campaignId, t.idempotencyKey)
      .where(sql`idempotency_key is not null`),
  ],
);
export const markets = pgTable(
  "markets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    city: text("city").notNull(),
    province: text("province"),
    sector: text("sector").notNull(),
    status: text("status", { enum: ["pending", "active", "saturated"] })
      .notNull()
      .default("pending"),
    discovered: integer("discovered").notNull().default(0),
    emailed: integer("emailed").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    lastGainAt: timestamp("last_gain_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("markets_campaign_city_sector_idx").on(t.campaignId, t.city, t.sector), index("markets_campaign_status_idx").on(t.campaignId, t.status)],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    message: text("message").notNull(),
    detail: jsonb("detail"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("run_events_campaign_idx").on(t.campaignId, t.createdAt), index("run_events_run_idx").on(t.runId, t.createdAt)],
);
export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  adapterType: text("adapter_type").notNull(),
  url: text("url"),
  query: text("query"),
  lastScrapedAt: timestamp("last_scraped_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    externalKey: text("external_key").notNull(),
    payload: jsonb("payload").notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("events_source_external_idx").on(t.sourceId, t.externalKey), index("events_unconsumed_idx").on(t.consumedAt, t.createdAt)],
);

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dedupeKey: text("dedupe_key").notNull(),
    name: text("name").notNull(),
    legalEntity: text("legal_entity"),
    website: text("website"),
    linkedinUrl: text("linkedin_url"),
    emailDomain: text("email_domain"),
    address: text("address"),
    city: text("city"),
    province: text("province"),
    country: text("country").notNull().default("Indonesia"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    phone: text("phone"),
    industryCategory: text("industry_category"),
    productsServices: jsonb("products_services").$type<string[]>(),
    rating: doublePrecision("rating"),
    reviewCount: integer("review_count"),
    branchesCount: integer("branches_count"),
    digitalPresence: jsonb("digital_presence").$type<{
      hasWebsite: boolean;
      socials: string[];
      waBusiness: boolean;
    }>(),
    raw: jsonb("raw"),
    emailHuntAttempts: integer("email_hunt_attempts").notNull().default(0),
    fieldProvenance: jsonb("field_provenance").$type<Record<string, unknown>>().notNull(),

    status: text("status", { enum: ["valid", "needs_review", "rejected"] })
      .notNull()
      .default("valid"),
    hasEmail: boolean("has_email").notNull().default(false),
    validationNotes: jsonb("validation_notes")
      .$type<Array<{ rule: string; message: string; at: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    createdByRunId: uuid("created_by_run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("companies_dedupe_key_idx").on(t.dedupeKey),
    index("companies_city_idx").on(t.city),
    index("companies_name_trgm_idx").using("gin", sql`name gin_trgm_ops`),
    index("companies_status_created_idx").on(t.status, t.createdAt),
    index("companies_email_created_idx")
      .on(t.createdAt)
      .where(sql`has_email`),
  ],
);

export const huntJobs = pgTable(
  "hunt_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: text("status", { enum: ["queued", "running", "succeeded", "failed", "cancelled"] })
      .notNull()
      .default("queued"),
    filter: jsonb("filter"),
    requestedCount: integer("requested_count").notNull().default(0),
    processedCount: integer("processed_count").notNull().default(0),
    emailsFound: integer("emails_found").notNull().default(0),
    outcomes: jsonb("outcomes").$type<HuntTargetOutcome[]>().notNull().default([]),
    error: text("error"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("hunt_jobs_status_idx").on(t.status, t.createdAt)],
);

export type HuntJob = typeof huntJobs.$inferSelect;

export interface HuntTargetOutcome {
  companyId: string;
  emailsFound: number;
  outcome: "found" | "no_website" | "site_unreachable" | "no_mx" | "domain_mismatch" | "no_contacts" | "exhausted_attempts";
}

export const ingestJobs = pgTable(
  "ingest_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    status: text("status", { enum: ["queued", "running", "succeeded", "failed"] })
      .notNull()
      .default("queued"),
    pagesTarget: integer("pages_target").notNull(),
    pagesDone: integer("pages_done").notNull().default(0),
    rowsSeen: integer("rows_seen").notNull().default(0),
    rowsWithEmail: integer("rows_with_email").notNull().default(0),
    newCompanies: integer("new_companies").notNull().default(0),
    newLeads: integer("new_leads").notNull().default(0),
    rejected: integer("rejected").notNull().default(0),
    flagged: integer("flagged").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("ingest_jobs_status_idx").on(t.status, t.createdAt)],
);

export const suppressions = pgTable(
  "suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email"),
    domain: text("domain"),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    reason: text("reason"),
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("suppressions_email_idx").on(t.email), index("suppressions_domain_idx").on(t.domain)],
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    name: text("name"),
    title: text("title"),
    email: text("email"),
    emailType: text("email_type", { enum: ["role", "personal", "verified-personal"] }),
    emailVerification: text("email_verification", { enum: ["unverified", "mx-ok", "smtp-ok", "catch-all", "undeliverable"] }),
    phone: text("phone"),
    phoneNormalized: text("phone_normalized"),
    whatsapp: text("whatsapp"),
    waLikely: boolean("wa_likely"),
    linkedinUrl: text("linkedin_url"),
    isDecisionMaker: boolean("is_decision_maker"),
    raw: jsonb("raw"),
    fieldProvenance: jsonb("field_provenance").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contacts_dedupe_key_idx").on(t.dedupeKey), index("contacts_company_idx").on(t.companyId)],
);

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),

    status: text("status", { enum: ["new", "ready", "synced"] })
      .notNull()
      .default("new"),
    enrichmentStatus: text("enrichment_status", { enum: ["pending", "partial", "complete", "failed"] })
      .notNull()
      .default("pending"),
    enrichmentAttempts: integer("enrichment_attempts").notNull().default(0),

    sheetSyncedAt: timestamp("sheet_synced_at", { withTimezone: true }),
    createdByRunId: uuid("created_by_run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("leads_campaign_company_idx").on(t.campaignId, t.companyId), index("leads_status_idx").on(t.status, t.createdAt)],
);

export const queryLedger = pgTable(
  "query_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    queryNorm: text("query_norm").notNull(),
    backend: text("backend").notNull(),
    resultCount: integer("result_count").notNull().default(0),
    leadsProduced: integer("leads_produced").notNull().default(0),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("query_ledger_campaign_idx").on(t.campaignId, t.createdAt), index("query_ledger_norm_idx").on(t.campaignId, t.queryNorm)],
);

export const geoCells = pgTable(
  "geo_cells",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    nicheNorm: text("niche_norm").notNull(),
    cellHash: text("cell_hash").notNull(),
    centerLat: doublePrecision("center_lat").notNull(),
    centerLng: doublePrecision("center_lng").notNull(),
    sweepCount: integer("sweep_count").notNull().default(0),
    companiesFound: integer("companies_found").notNull().default(0),
    consecutiveEmpty: integer("consecutive_empty").notNull().default(0),
    capHit: integer("cap_hit").notNull().default(0),
    doneAt: timestamp("done_at", { withTimezone: true }),
    lastSweptAt: timestamp("last_swept_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("geo_cells_campaign_niche_cell_idx").on(t.campaignId, t.nicheNorm, t.cellHash)],
);

export const leadSources = pgTable(
  "lead_sources",
  {
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    scrapedAt: timestamp("scraped_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("lead_sources_lead_source_idx").on(t.leadId, t.sourceId)],
);

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const llmProviders = pgTable(
  "llm_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: text("label").notNull(),
    kind: text("kind").notNull(),
    baseUrl: text("base_url").notNull(),
    apiKeySealed: text("api_key_sealed").notNull(),
    extraHeaders: jsonb("extra_headers").$type<Record<string, string>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("llm_providers_label_idx").on(table.label)],
);

export const models = pgTable(
  "models",
  {
    providerId: uuid("provider_id")
      .notNull()
      .references(() => llmProviders.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    ownedBy: text("owned_by").notNull(),
    contextLength: integer("context_length"),
    maxCompletionTokens: integer("max_completion_tokens"),
    capabilities: jsonb("capabilities").$type<{
      vision: boolean;
      reasoning: boolean;
      tools: boolean;
    }>(),
    pricing: jsonb("pricing").$type<{ promptPerM?: number; completionPerM?: number }>(),
    isCombo: boolean("is_combo").notNull().default(false),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.providerId, table.id] })],
);

export const companiesRelations = relations(companies, ({ many }) => ({
  contacts: many(contacts),
  leads: many(leads),
}));

export const contactsRelations = relations(contacts, ({ one }) => ({
  company: one(companies, { fields: [contacts.companyId], references: [companies.id] }),
}));

export const leadsRelations = relations(leads, ({ one, many }) => ({
  company: one(companies, { fields: [leads.companyId], references: [companies.id] }),
  contact: one(contacts, { fields: [leads.contactId], references: [contacts.id] }),
  campaign: one(campaigns, { fields: [leads.campaignId], references: [campaigns.id] }),
  sources: many(leadSources),
}));

export const campaignsRelations = relations(campaigns, ({ one, many }) => ({
  user: one(users, { fields: [campaigns.userId], references: [users.id] }),
  runs: many(runs),
  leads: many(leads),
}));

export type User = typeof users.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type QueryLedgerRow = typeof queryLedger.$inferSelect;
export type SourceRow = typeof sources.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type ModelRow = typeof models.$inferSelect;

export const webSearchCache = pgTable(
  "web_search_cache",
  {
    queryHash: text("query_hash").primaryKey(),
    query: text("query").notNull(),
    results: jsonb("results").$type<WebResultRow[]>().notNull(),
    backend: text("backend").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("web_search_cache_created_idx").on(t.createdAt)],
);

export type WebResultRow = { title: string; url: string; snippet: string | null };
