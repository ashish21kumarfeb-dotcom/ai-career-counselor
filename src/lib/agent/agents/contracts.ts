// A2A message contracts for the four SRS agents (Profile, Career Data,
// Recommendation, Verification). These are the EXPLICIT input/output DTOs each
// agent exchanges — the thing that makes this a real multi-agent flow rather than
// renamed nodes. Agent cores validate their OUTPUT against these before returning,
// so a malformed hand-off is caught at the boundary.
//
// Scaffolding only in this step: nothing imports these yet. The agent cores and
// node wrappers wired in later steps consume them. No runtime behavior changes.
import { z } from "zod";
import type { Intent } from "../../ai/intent";
import type { AgentPlan, ResponseSections, SectionName } from "../schema";

// --- Shared item shapes (structurally identical to schema.ts's ResourceItem /
// AgencyItem / RetrievedDocument, defined here in Zod so the retrieval outputs can
// be validated at the hand-off boundary). ---
export const resourceItemSchema = z.object({
  title: z.string(),
  type: z.string(),
  url: z.string().nullable(),
});

export const agencyItemSchema = z.object({
  name: z.string(),
  location: z.string().nullable(),
  services: z.string().nullable(),
  website: z.string().nullable(),
  source: z.string().nullable(),
});

export const retrievedDocSchema = z.object({
  id: z.string(),
  type: z.string(),
  content: z.string(),
  sourceUrl: z.string().nullable(),
});

export const sourceRefSchema = z.object({
  id: z.string(),
  type: z.string(),
  sourceUrl: z.string().nullable(),
});

// --- 1. Profile Agent ---------------------------------------------------------
// Responsibility: load + summarize the user's profile and relevant memory, and
// distil their background and hard constraints. Deterministic (no LLM) so its
// output is stable and cheaply testable.
export const userContextSchema = z.object({
  stage: z.string().nullable(),
  currentRole: z.string().nullable(),
  skills: z.array(z.string()),
  interests: z.array(z.string()),
  careerGoal: z.string().nullable(),
  location: z.string().nullable(),
});

export const profileAgentOutputSchema = z.object({
  profileSummary: z.string(),
  memorySummary: z.string(),
  userContext: userContextSchema,
  importantConstraints: z.array(z.string()),
});

export type UserContext = z.infer<typeof userContextSchema>;
export type ProfileAgentOutput = z.infer<typeof profileAgentOutputSchema>;

export interface ProfileAgentInput {
  userId: string;
  query: string;
  intent: Intent;
}

// --- 2. Career Data Agent -----------------------------------------------------
// Responsibility: retrieve ONLY verified DB/tool data — RAG grounding docs plus,
// when the plan asks for them, resource/course links and agencies. Never invents.
// The RAW row shapes the MCP tools return over the wire. These mirror
// RetrievedAgency / RetrievedDocument, and exist so the client can re-validate a
// JSON payload at the protocol boundary rather than trusting it — MCP hands back
// text, so without this the typed rows would be a cast, not a fact.
// (mcpDocumentRowSchema is retrievedDocSchema; aliased so the boundary's intent
// reads clearly at the call site.)
export const mcpAgencyRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  location: z.string().nullable(),
  services: z.string().nullable(),
  website: z.string().nullable(),
  sourceUrl: z.string().nullable(),
});
export const mcpDocumentRowSchema = retrievedDocSchema;

// What actually happened for one tool on one run: which transport carried it,
// whether it succeeded, and why it degraded if it did. Required (not optional) so
// every construction site has to state it — an audit field that can be omitted
// gets omitted, and "did this really run over MCP?" is exactly the question a
// reviewer asks first.
export const toolCallRecordSchema = z.object({
  tool: z.string(),
  transport: z.enum(["mcp", "direct", "skipped"]),
  ok: z.boolean(),
  items: z.number(),
  degradedReason: z.string().optional(),
});
export type ToolCallRecord = z.infer<typeof toolCallRecordSchema>;

export const careerDataAgentOutputSchema = z.object({
  ragDocs: z.array(retrievedDocSchema),
  resources: z.array(resourceItemSchema),
  courses: z.array(resourceItemSchema),
  agencies: z.array(agencyItemSchema),
  sourcesUsed: z.array(sourceRefSchema),
  missingDataNotes: z.array(z.string()),
  // One record per retrieval tool this run considered — the evidence behind any
  // claim about how tools executed.
  toolCalls: z.array(toolCallRecordSchema),
});

export type CareerDataAgentOutput = z.infer<typeof careerDataAgentOutputSchema>;

export interface CareerDataAgentInput {
  userId: string;
  query: string;
  intent: Intent;
  plannedSections: SectionName[];
  // Handed off from the Profile Agent — used only to nudge resource RANKING toward
  // the user's field/goal; never grants inclusion on its own.
  userContext: UserContext;
}

// --- 3. Recommendation Agent --------------------------------------------------
// Responsibility: assemble the final dynamic sections from the Profile Agent and
// Career Data Agent outputs. DB sections are mapped directly; text sections are
// LLM-generated and grounded. Only planned sections are produced.

// What the Verification Agent sends BACK when it rejects a draft. This is the
// hand-off that makes the A2A loop a conversation rather than a pipeline: the
// Recommendation Agent gets told what was wrong and writes a corrected draft.
export interface VerificationFeedback {
  issues: string[];
  notes: string;
  recommendedFix?: string;
}

export interface RecommendationAgentInput {
  query: string;
  intent: Intent;
  plan: AgentPlan;
  profile: ProfileAgentOutput;
  careerData: CareerDataAgentOutput;
  // Present only on a regeneration pass. Absent on the first attempt.
  feedback?: VerificationFeedback;
}

export interface RecommendationAgentOutput {
  draftSections: ResponseSections;
  finalAnswerText?: string;
}

// --- Runtime schemas for the last two hand-offs -------------------------------
// Only the Profile and Career Data outputs were validated at runtime; the
// Recommendation and Verification hand-offs were plain TS interfaces, i.e.
// compile-time only. That made "typed A2A hand-offs" a half-true claim, and it
// matters more now: the regeneration loop passes these envelopes around twice.
//
// These validate-and-log rather than replacing the value (runVerificationAgent
// returns its own constructed output either way), so the zod shape stays a
// checker and never becomes the source of truth for the TS type.
const sourcedSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), note: z.string().optional() });

export const responseSectionsSchema = z.object({
  ai_suggestion: z.string().optional(),
  roadmap: z.object({ items: z.array(z.string()), suggested: z.boolean() }).optional(),
  resources: sourcedSchema(resourceItemSchema).optional(),
  courses: sourcedSchema(resourceItemSchema).optional(),
  skill_focus: z.array(z.string()).optional(),
  agencies: sourcedSchema(agencyItemSchema).optional(),
  next_steps: z.array(z.string()).optional(),
});

export const recommendationAgentOutputSchema = z.object({
  draftSections: responseSectionsSchema,
  finalAnswerText: z.string().optional(),
});

export const verificationAgentOutputSchema = z.object({
  approved: z.boolean(),
  grounded: z.boolean(),
  safe: z.boolean(),
  softCheckAvailable: z.boolean(),
  issues: z.array(z.string()),
  verificationNotes: z.string(),
  recommendedFix: z.string().optional(),
  finalSections: responseSectionsSchema,
});

// --- 4. Verification Agent ----------------------------------------------------
// Responsibility: enforce grounding/safety. Deterministic hard checks (invented
// agencies/resources/links, section/plan mismatch) ALWAYS run and can flip
// `approved` false and sanitize the response. A soft LLM check judges free-text
// grounding/safety.
//
// Correction #1 (no silent permissive success): when the soft LLM check errors,
// `softCheckAvailable` is false, `grounded`/`safe` must NOT be reported as
// confidently true, and the unavailability is surfaced in issues/verificationNotes.
// `approved` then derives from the deterministic checks alone.
export interface VerificationAgentInput {
  query: string;
  plan: AgentPlan;
  draftSections: ResponseSections;
  careerData: CareerDataAgentOutput;
}

export interface VerificationAgentOutput {
  approved: boolean;
  grounded: boolean;
  safe: boolean;
  // False when the soft LLM verification could not run (error/invalid output).
  // Consumers must treat grounded/safe as UNKNOWN, not positive, in that case.
  softCheckAvailable: boolean;
  issues: string[];
  verificationNotes: string;
  recommendedFix?: string;
  // The response after any sanitization (offending sections dropped / unsafe text
  // replaced). Equal to the input draftSections when nothing had to change.
  finalSections: ResponseSections;
}
