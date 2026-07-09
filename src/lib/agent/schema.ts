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
  if (needs.agencies && agencyGate(query)) sections.push("agencies");
  if (needs.nextSteps) sections.push("next_steps");

  if (sections.length === 0) sections.push("ai_suggestion");

  return { sections, reasoning };
}
