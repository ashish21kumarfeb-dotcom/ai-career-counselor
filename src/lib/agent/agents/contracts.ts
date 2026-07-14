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
export const careerDataAgentOutputSchema = z.object({
  ragDocs: z.array(retrievedDocSchema),
  resources: z.array(resourceItemSchema),
  courses: z.array(resourceItemSchema),
  agencies: z.array(agencyItemSchema),
  sourcesUsed: z.array(sourceRefSchema),
  missingDataNotes: z.array(z.string()),
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
export interface RecommendationAgentInput {
  query: string;
  intent: Intent;
  plan: AgentPlan;
  profile: ProfileAgentOutput;
  careerData: CareerDataAgentOutput;
}

export interface RecommendationAgentOutput {
  draftSections: ResponseSections;
  finalAnswerText?: string;
}

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
