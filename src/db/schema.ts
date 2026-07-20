import { boolean, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["user", "admin", "agency_owner"]);

// `job_switcher` is retained for legacy rows only — it is no longer offered in
// onboarding (working_professional now covers career switching). Do NOT remove
// it: Postgres cannot safely drop an in-use enum value, and old rows must stay
// valid. `parent_guardian` = a parent/guardian seeking guidance for their child.
export const userType = pgEnum("user_type", [
  "student",
  "fresher",
  "working_professional",
  "job_switcher",
  "parent_guardian",
]);

export const documentType = pgEnum("document_type", [
  "resume",
  "career_data",
  "blog_post",
  "industry_article",
  "agency_record",
]);

export const verificationStatus = pgEnum("verification_status", [
  "pending",
  "verified",
  "rejected",
]);

// How an /api/agent-chat run ended. Mirrors FINAL_STATUSES in
// src/lib/agent/trace/types.ts — keep the two in sync.
// `regenerated` and `fallback` are only reachable once the verification
// regeneration loop lands; they are defined up front because Postgres cannot
// safely drop an in-use enum value later (same reasoning as `job_switcher`).
export const runStatus = pgEnum("run_status", [
  "approved",
  "corrected",
  "regenerated",
  "fallback",
  "failed",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name"),
  email: varchar("email").notNull().unique(),
  passwordHash: varchar("password_hash"),
  role: userRole("role").notNull().default("user"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const userProfiles = pgTable("user_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  userType: userType("user_type").notNull(),
  education: varchar("education"),
  currentRole: varchar("current_role"),
  skills: text("skills"),
  interests: text("interests"),
  careerGoal: text("career_goal"),
  location: varchar("location"),
  // Total years of work experience (working professionals). Dedicated numeric
  // column so it can be filtered/sorted/aggregated. Nullable — only set for types
  // that collect it; legacy rows may still carry it in `details` (no backfill).
  yearsExperience: integer("years_experience"),
  // Type-specific onboarding answers that don't map to a common column (e.g.
  // student stream/favorite subjects, fresher graduation year, working-pro
  // grow-vs-switch, parent's child strengths). Nullable; existing rows stay null.
  details: jsonb("details"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const aiRecommendations = pgTable("ai_recommendations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  query: text("query").notNull(),
  intent: varchar("intent"),
  finalAnswer: text("final_answer"),
  sourcesUsed: jsonb("sources_used"),
  evaluationScore: jsonb("evaluation_score"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  type: documentType("type").notNull(),
  content: text("content").notNull(),
  sourceUrl: varchar("source_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const memory = pgTable(
  "memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    memoryKey: varchar("memory_key").notNull(),
    memoryValue: text("memory_value").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  // One row per (user, memory_key): enables upsert on this pair.
  (t) => [unique("memory_user_key_unique").on(t.userId, t.memoryKey)]
);

// One row per /api/agent-chat run: the persisted audit trace.
//
// A separate table rather than columns on `ai_recommendations`, because a run can
// end without ever producing a recommendation (it can fail, or ship a fallback),
// and because ai_recommendations' two jsonb columns are already spoken for. This
// also keeps that table's contract stable for existing readers.
//
// `run_id` is the caller-supplied correlation id (unique), distinct from the row's
// own `id`. `recommendation_id` is nullable: a failed run has no recommendation.
export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().unique(),
  userId: uuid("user_id").references(() => users.id),
  query: text("query").notNull(),
  intent: varchar("intent"),
  executionPlan: jsonb("execution_plan"),
  trace: jsonb("trace"),
  finalStatus: runStatus("final_status").notNull(),
  recommendationId: uuid("recommendation_id").references(() => aiRecommendations.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Retrievable passages of a document.
//
// Retrieval reads THIS table, not `documents` — a document is the unit of
// ownership and provenance, a chunk is the unit of matching. Keeping them
// separate means the source row stays the single place a resume or article
// lives (one delete, one owner, one source_url) while the text can be
// re-segmented at will by re-running the backfill.
//
// ON DELETE CASCADE is the load-bearing constraint here. Resume replacement
// deletes the old `documents` row on every upload, and orphaned chunks would
// stay retrievable forever — the previous resume's content grounding answers
// after the user replaced it, which is both wrong and a privacy failure. The
// database enforces that, not application code.
//
// `chunk_index` is the passage's ordinal within its document, unique per
// document so a re-chunk cannot silently double the corpus.
export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [unique("document_chunks_doc_index_unique").on(t.documentId, t.chunkIndex)]
);

// One row per LLM call: the token ledger.
//
// Exists to answer questions this system could not previously answer at all —
// how many tokens a run actually costs, which call site dominates, how wide the
// spread is, and how close the prompt gets to the model's context limit. Every
// number here is REPORTED BY THE PROVIDER, not estimated locally, so it can be
// trusted as a basis for setting budgets later.
//
// Recorded BEFORE any allocator exists, deliberately. Caps chosen without a
// measured distribution are guesses that get enforced as if they were policy;
// the ones that are too tight silently truncate good context and the ones that
// are too loose never fire. Measure first, then set caps from the data.
//
// `run_id` is the agent-chat correlation id, nullable and intentionally NOT a
// foreign key: usage flushes at the end of a run that may have failed before
// agent_runs was ever written, and a constraint here would drop exactly the
// expensive failed runs that are most worth studying. Some calls (resume memory
// extraction) have no run at all.
export const llmUsage = pgTable("llm_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id"),
  userId: uuid("user_id").references(() => users.id),
  // Which call site spent the tokens ("intent", "planner", "recommendation", …).
  callSite: varchar("call_site").notNull(),
  model: varchar("model").notNull(),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  // Set when the call threw: a failed call still consumed wall-clock and may have
  // consumed tokens, and a ledger that only records successes understates cost.
  failed: boolean("failed").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Fixed-window rate-limit counters.
//
// In Postgres rather than memory because there is no other shared state. Next.js
// route handlers on a serverless host run in short-lived, independently scaled
// instances: a module-level Map would give each instance its own private counter,
// so the effective limit would be (configured limit x number of live instances)
// and would reset on every cold start. That is not a rate limit, it is a rate
// suggestion. Neon is already the one thing every instance agrees on.
//
// One row per (subject, bucket, window_start). The window start is quantized by
// the caller, which makes the row key deterministic and lets the whole check be a
// single atomic `INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING
// count`. That matters on the neon-http driver, where each statement is its own
// HTTP round trip and there is no transaction to wrap a read-then-write in — a
// read-modify-write here would race two concurrent requests into the same count.
//
// `subject` is a scheme-prefixed identity ("user:<uuid>"), so limits keyed on
// different things cannot collide in the same namespace.
export const rateLimits = pgTable(
  "rate_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subject: varchar("subject").notNull(),
    bucket: varchar("bucket").notNull(),
    windowStart: timestamp("window_start").notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("rate_limits_subject_bucket_window_unique").on(t.subject, t.bucket, t.windowStart)]
);

export const consultingAgencies = pgTable("consulting_agencies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name").notNull(),
  location: varchar("location"),
  services: text("services"),
  website: varchar("website"),
  verificationStatus: verificationStatus("verification_status")
    .notNull()
    .default("pending"),
  sourceUrl: varchar("source_url"),
  lastVerified: timestamp("last_verified"),
});
