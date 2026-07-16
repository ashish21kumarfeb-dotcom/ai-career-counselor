// The ExecutionPlan: the first-class artifact describing what a run intends to do.
//
// The pre-existing "planner" emitted seven booleans and a sentence — it chose
// output SECTIONS and nothing else. This type is what an execution plan actually
// has to say: the goal, the context it needs, the agents and tools it intends to
// use, the risk checks that apply, and the sections it expects to produce.
//
// See registry.ts for which of these fields the graph ENFORCES versus merely
// DECLARES. That distinction is deliberate and load-bearing: this artifact is the
// thing we show people, so it must not imply control the workflow does not have.
import { z } from "zod";
import {
  AGENT_NAMES,
  CONTEXT_REQUIREMENTS,
  RISK_CHECKS,
  TOOL_NAMES,
  type AgentName,
  type ContextRequirement,
  type RiskCheck,
  type ToolName,
} from "./registry";
import { SECTIONS, type SectionName } from "../schema";

// A tool the plan intends to call, plus what governance decided about it.
// `allowed:false` is the interesting case: the planner asked, a gate said no.
export type PlannedToolCall = {
  tool: ToolName;
  reason: string;
  gated: boolean; // was a deterministic gate consulted for this tool?
  allowed: boolean; // final verdict — false means it will NOT run
};

// The outcome of a deterministic risk check for this query.
export type RiskCheckDecision = {
  check: RiskCheck;
  triggered: boolean; // did the risk apply to this query at all?
  action: "allow" | "veto";
  note: string;
};

export type ExecutionPlan = {
  goal: string;
  requiredContext: ContextRequirement[];
  agents: AgentName[];
  tools: PlannedToolCall[];
  riskChecks: RiskCheckDecision[];
  expectedSections: SectionName[];
  reasoning: string;
  // True when the planner LLM was unavailable or produced invalid output and this
  // plan came from the deterministic fallback. A degraded plan is not a plan the
  // model made — the trace and the demo must be able to tell the difference.
  degraded: boolean;
  // What finalizeExecutionPlan() changed about the proposal: unregistered names
  // dropped, mandatory agents forced back in, tools vetoed by a gate. This is the
  // audit record of governance overruling the model.
  planIssues: string[];
};

// ---------------------------------------------------------------------------
// What the planner LLM is allowed to return. Deliberately NARROWER than
// ExecutionPlan: the model proposes goal/context/agents/tools/sections and its
// reasoning. It does NOT get to declare `riskChecks` (those are computed from the
// deterministic gates — a model must never author its own risk assessment),
// `degraded`, or `planIssues`.
// ---------------------------------------------------------------------------
export const plannerProposalSchema = z.object({
  goal: z.string(),
  // Enums are permissive at the edge (z.string()) rather than z.enum(): an
  // unknown name must be DROPPED AND RECORDED by finalizeExecutionPlan, not cause
  // the whole proposal to fail validation and lose the good parts with it.
  requiredContext: z.array(z.string()),
  agents: z.array(z.string()),
  tools: z.array(z.object({ tool: z.string(), reason: z.string() })),
  expectedSections: z.array(z.string()),
  reasoning: z.string(),
});
export type PlannerProposal = z.infer<typeof plannerProposalSchema>;

// Vocabularies rendered for the planner prompt, so the prompt and the registry
// can never drift apart.
export const PROMPT_VOCABULARY = {
  context: CONTEXT_REQUIREMENTS.join(" | "),
  agents: AGENT_NAMES.join(" | "),
  tools: TOOL_NAMES.join(" | "),
  sections: SECTIONS.join(" | "),
  risks: RISK_CHECKS.join(" | "),
} as const;

export type { SectionName };
