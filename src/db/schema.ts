import { integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

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
