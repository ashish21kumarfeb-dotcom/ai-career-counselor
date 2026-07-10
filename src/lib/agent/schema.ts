// Planner contract for the agentic-chat POC: the sections a response may contain,
// the zod schema the planner LLM must satisfy, the deterministic gates that make
// the sensitive sections safe, and finalizePlan() which turns the LLM's proposed
// "needs" into the final, gated section list.
import { z } from "zod";

// The six sections a dynamic response may include, in a stable render order.
export const SECTIONS = [
  "ai_suggestion",
  "roadmap",
  "resources",
  "courses",
  "skill_focus",
  "agencies",
  "next_steps",
] as const;

export type SectionName = (typeof SECTIONS)[number];

// The planner LLM proposes a boolean per candidate section plus its reasoning.
// We validate this, then apply the gates below — the LLM proposes, code enforces.
export const plannerNeedsSchema = z.object({
  needs: z.object({
    aiSuggestion: z.boolean(),
    roadmap: z.boolean(),
    resources: z.boolean(),
    courses: z.boolean(),
    skillFocus: z.boolean(),
    agencies: z.boolean(),
    nextSteps: z.boolean(),
  }),
  reasoning: z.string(),
});

export type PlannerNeeds = z.infer<typeof plannerNeedsSchema>;

// The finalized plan handed to the rest of the graph.
export type AgentPlan = {
  sections: SectionName[];
  reasoning: string;
};

// --- Final response sections --------------------------------------------------
// A DB-backed link/agency item. Never LLM-invented — always mapped from a tool
// result row.
export type ResourceItem = { title: string; type: string; url: string | null };
export type AgencyItem = {
  name: string;
  location: string | null;
  services: string | null;
  website: string | null;
  source: string | null;
};

// A DB-backed section: its items plus an optional note. When the section was
// requested but the tool returned nothing, items is [] and note states plainly
// that no verified data was found (never invented).
export type Sourced<T> = { items: T[]; note?: string };

// The dynamic response: only the planned sections are present.
export type ResponseSections = {
  ai_suggestion?: string;
  // roadmap.suggested = true means it is a general suggested roadmap (opinion),
  // NOT grounded in a verified resource.
  roadmap?: { items: string[]; suggested: boolean };
  resources?: Sourced<ResourceItem>;
  courses?: Sourced<ResourceItem>;
  // Skills the user should focus on / close the gap on, derived from their
  // profile skills vs. their goal. LLM-generated guidance (not verified data).
  skill_focus?: string[];
  agencies?: Sourced<AgencyItem>;
  next_steps?: string[];
};

// Reflection/verification result recorded on the response.
export type Verification = { grounded: boolean; safe: boolean; notes: string };

// --- Evaluation (SRS §8) ------------------------------------------------------
// Custom LLM evaluator. Each numeric metric is 0-10; hallucination_risk is
// categorical. `overall` is computed in code (mean of the five numerics), not by
// the model, so it is consistent. Stored on ai_recommendations.evaluation_score.
export const evaluationSchema = z.object({
  groundedness: z.coerce.number().min(0).max(10),
  relevance: z.coerce.number().min(0).max(10),
  personalization: z.coerce.number().min(0).max(10),
  actionability: z.coerce.number().min(0).max(10),
  safety: z.coerce.number().min(0).max(10),
  hallucination_risk: z.enum(["low", "medium", "high"]),
  notes: z.string(),
});

export type EvaluationScore = z.infer<typeof evaluationSchema> & {
  overall: number;
};

// --- Deterministic gates -----------------------------------------------------
// Agencies are the SENSITIVE section (SRS: never push consultation the user did
// not ask for, never invent agencies), so this gate is a hard veto: agencies are
// allowed ONLY when the query explicitly asks for a human help/guidance provider.
// Deliberately does NOT match a bare "help" (too broad — over-shows agencies);
// it matches provider terms only.
const AGENCY_TERMS =
  /\b(counsel\w*|consult\w*|mentor\w*|agenc(?:y|ies)|advis\w*|coach\w*|guidance)\b/i;

// Resources/courses are benign, so this gate is broad: it passes for essentially
// any career-guidance or learning query, and only vetoes when the query is a pure
// agency lookup or off-topic. The LLM's `needs` booleans do the fine selection.
const RESOURCE_TERMS =
  /\b(career\w*|path\w*|role\w*|job\w*|switch\w*|transition\w*|becom\w*|learn\w*|roadmap\w*|skill\w*|course\w*|certif\w*|prepar\w*|resource\w*|stud(?:y|ies|ying)|tutorial\w*|material\w*|upskill\w*|training)\b/i;

export function agencyGate(query: string): boolean {
  return AGENCY_TERMS.test(query);
}

export function resourceGate(query: string): boolean {
  return RESOURCE_TERMS.test(query);
}

// Turn proposed needs into the final, gated section list (stable order). Agencies
// and resources/courses survive only if their gate also passes. Always returns at
// least one section so the graph never produces an empty response.
export function finalizePlan(
  proposed: PlannerNeeds,
  query: string
): AgentPlan {
  const { needs, reasoning } = proposed;
  const sections: SectionName[] = [];

  if (needs.aiSuggestion) sections.push("ai_suggestion");
  if (needs.roadmap) sections.push("roadmap");
  if (needs.resources && resourceGate(query)) sections.push("resources");
  if (needs.courses && resourceGate(query)) sections.push("courses");
  // skill_focus is benign guidance; gate it like resources (learning/career
  // queries) so it does not appear on pure agency lookups or off-topic asks.
  if (needs.skillFocus && resourceGate(query)) sections.push("skill_focus");
  if (needs.agencies && agencyGate(query)) sections.push("agencies");
  if (needs.nextSteps) sections.push("next_steps");

  if (sections.length === 0) sections.push("ai_suggestion");

  return { sections, reasoning };
}
