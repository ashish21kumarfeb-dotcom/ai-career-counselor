// The execution registry: the closed vocabularies an execution plan may draw on.
//
// This is the "allowlist disposes" half of the workflow's governance pattern. The
// planner LLM proposes agents, tools, and context; nothing it names outside these
// lists survives finalizeExecutionPlan(). Same philosophy as the section gates in
// ../schema.ts and the subset checks in sanitizeDraft(): the model is a proposer,
// never an authority.
//
// ---------------------------------------------------------------------------
// ENFORCEMENT HONESTY — read before claiming the plan "controls" the workflow.
//
// The graph is currently static: it runs all four agents, in a fixed order, on
// every request. So the fields of an ExecutionPlan are NOT equally real:
//
//   expectedSections  ENFORCED  — finalizePlan() gates decide the response shape,
//                                 and verification deletes unplanned sections.
//   tools             ENFORCED  — careerData.ts re-checks the gates at the
//                                 retrieval boundary; a vetoed tool does not run.
//   riskChecks        ENFORCED  — these ARE the gate outcomes, recorded.
//   agents            DECLARED  — all four always run (each is structurally
//                                 required today). The plan records what the goal
//                                 needs; it does not yet skip nodes.
//   requiredContext   DECLARED  — profile/memory/RAG are always loaded.
//
// Making agents/context conditional would need real conditional edges. Faking it
// (branching on a plan the graph ignores) would be worse than saying so.
// ---------------------------------------------------------------------------

// Context an execution plan can declare it needs.
export const CONTEXT_REQUIREMENTS = ["profile", "memory", "global_rag", "user_rag"] as const;
export type ContextRequirement = (typeof CONTEXT_REQUIREMENTS)[number];

// The four agents in the workflow.
export const AGENT_NAMES = ["profile", "career_data", "recommendation", "verification"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

// Every agent is structurally required by the current graph: profile populates
// the compat channels evaluate reads, career_data always runs RAG grounding, and
// recommendation/verification produce and police the answer. A plan that omits
// one is overruled and the override is recorded — the planner does not get to
// silently drop the verifier.
export const MANDATORY_AGENTS: readonly AgentName[] = AGENT_NAMES;

// The retrieval tools. `searchDocuments` is RAG grounding (always runs,
// user-scoped); searchResources/searchAgencies are DB-backed and gated. The three
// external tools (Tavily) are gated on their own keyword gates AND on
// externalSearchEnabled(); they run at the retrieval boundary (careerData.ts), are
// derived into the plan with the SAME gate (finalize.ts), and are recorded in
// toolCalls/trace — so plan and retrieval never disagree about what runs.
export const TOOL_NAMES = [
  "searchDocuments",
  "searchResources",
  "searchAgencies",
  "searchCareerRoadmaps",
  "searchMarketSignals",
  "searchIndustryArticles",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

// Risk checks this workflow can apply. Each maps to a deterministic control that
// already exists — these are recorded outcomes, not aspirations.
//   agency_push       — agencyGate: never surface a provider the user didn't ask for.
//   unverified_links  — resource/course items come only from DB rows with http URLs.
//   invented_provider — sanitizeDraft: prose naming an unbacked provider is removed.
//   guarantees        — prompt rule + soft check: no guaranteed jobs/salaries.
export const RISK_CHECKS = ["agency_push", "unverified_links", "invented_provider", "guarantees"] as const;
export type RiskCheck = (typeof RISK_CHECKS)[number];

const AGENT_SET: ReadonlySet<string> = new Set(AGENT_NAMES);
const TOOL_SET: ReadonlySet<string> = new Set(TOOL_NAMES);
const CONTEXT_SET: ReadonlySet<string> = new Set(CONTEXT_REQUIREMENTS);

export function isAgentName(value: string): value is AgentName {
  return AGENT_SET.has(value);
}
export function isToolName(value: string): value is ToolName {
  return TOOL_SET.has(value);
}
export function isContextRequirement(value: string): value is ContextRequirement {
  return CONTEXT_SET.has(value);
}
