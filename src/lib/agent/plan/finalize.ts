// Turning a planner PROPOSAL into a governed ExecutionPlan.
//
// This is the "dispose" half of propose/dispose. Everything the planner LLM said
// passes through here, and this module — not the model — decides what the run is
// actually allowed to do:
//   - names outside the registry are dropped and recorded
//   - structurally required agents are forced back in
//   - sections go through the EXISTING finalizePlan() gates (one source of truth)
//   - tools are re-derived from the gated plan, so a vetoed tool cannot be planned
//   - risk checks are COMPUTED from the gate outcomes, never authored by the model
//
// Pure and deterministic: no LLM, no I/O. Every branch is unit-testable.
import {
  agencyGate,
  finalizePlan,
  resourceGate,
  SECTIONS,
  type AgentPlan,
  type PlannerNeeds,
  type SectionName,
} from "../schema";
import {
  MANDATORY_AGENTS,
  isAgentName,
  isContextRequirement,
  isToolName,
  type AgentName,
  type ContextRequirement,
  type ToolName,
} from "./registry";
import type {
  ExecutionPlan,
  PlannedToolCall,
  PlannerProposal,
  RiskCheckDecision,
} from "./types";

const SECTION_SET: ReadonlySet<string> = new Set(SECTIONS);

// ---------------------------------------------------------------------------
// Fallback: what the planner produces when its LLM is unavailable or returned
// invalid output. Lives here (not in the planner node) so the node can depend on
// this module without a cycle, and so the fail-closed rule is unit-testable in
// isolation from the graph.
// ---------------------------------------------------------------------------

// `agencies` is hard-coded false, NOT agencyGate(query). finalizePlan gates the
// agencies section on `needs.agencies && agencyGate(query)` — two independent
// keys: the planner's judgment and the deterministic gate. Deriving needs.agencies
// FROM the gate collapses that AND into `gate && gate`, leaving a single keyword
// enough to push agencies at a user who never asked for a provider ("what guidance
// do you have?" matches). With the planner's judgment unavailable, the sensitive
// section fails closed. Exported for tests.
export function fallbackNeeds(query: string): PlannerNeeds {
  return {
    needs: {
      aiSuggestion: true,
      roadmap: /\b(roadmap|plan|steps|how (?:do|to)|become|switch|transition)\b/i.test(query),
      resources: resourceGate(query),
      courses: /\b(course\w*|certif\w*|training)\b/i.test(query),
      skillFocus: /\b(skill\w*|learn\w*|roadmap|become|switch|transition|prepar\w*|gap)\b/i.test(query),
      agencies: false,
      nextSteps: false,
    },
    reasoning: "fallback plan (planner LLM unavailable or returned invalid output)",
  };
}

function sectionsFromNeeds(needs: PlannerNeeds["needs"]): SectionName[] {
  const out: SectionName[] = [];
  if (needs.aiSuggestion) out.push("ai_suggestion");
  if (needs.roadmap) out.push("roadmap");
  if (needs.resources) out.push("resources");
  if (needs.courses) out.push("courses");
  if (needs.skillFocus) out.push("skill_focus");
  if (needs.agencies) out.push("agencies");
  if (needs.nextSteps) out.push("next_steps");
  return out;
}

// A gate-safe proposal derived from the query alone. The goal is stated plainly as
// unknown-because-degraded rather than paraphrasing the query as if a model had
// understood it.
export function fallbackProposal(query: string): PlannerProposal {
  const { needs, reasoning } = fallbackNeeds(query);
  return {
    goal: "Answer the user's career question (planner unavailable; goal not modelled).",
    requiredContext: ["profile", "memory", "global_rag", "user_rag"],
    agents: [...MANDATORY_AGENTS],
    tools: [],
    expectedSections: sectionsFromNeeds(needs),
    reasoning,
  };
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

function needsFromSections(sections: SectionName[], reasoning: string): PlannerNeeds {
  const has = (s: SectionName) => sections.includes(s);
  return {
    needs: {
      aiSuggestion: has("ai_suggestion"),
      roadmap: has("roadmap"),
      resources: has("resources"),
      courses: has("courses"),
      skillFocus: has("skill_focus"),
      agencies: has("agencies"),
      nextSteps: has("next_steps"),
    },
    reasoning,
  };
}

// Tools are DERIVED from the gated plan, not taken from the proposal. A tool the
// planner asked for whose section the gates removed must not appear as planned —
// the artifact has to describe what will actually happen.
//
// This mirrors runCareerDataAgent()'s own gating exactly (careerData.ts): the plan
// and the retrieval boundary must never disagree about what runs.
function deriveTools(
  finalSections: SectionName[],
  proposed: PlannerProposal["tools"],
  query: string
): { tools: PlannedToolCall[]; issues: string[] } {
  const issues: string[] = [];
  const reasonFor = (name: ToolName, fallback: string) =>
    proposed.find((t) => t.tool === name)?.reason ?? fallback;

  const wantsAgencies = finalSections.includes("agencies");
  const wantsResources = finalSections.includes("resources") || finalSections.includes("courses");

  const tools: PlannedToolCall[] = [
    {
      // RAG grounding is unconditional and user-scoped. It is listed even when the
      // planner forgot to ask for it: a plan that omits a tool that runs is a lie.
      tool: "searchDocuments",
      reason: reasonFor("searchDocuments", "RAG grounding — always runs, user-scoped."),
      gated: false,
      allowed: true,
    },
    {
      tool: "searchResources",
      reason: reasonFor("searchResources", "Retrieve verified resource/course links."),
      gated: true,
      allowed: wantsResources && resourceGate(query),
    },
    {
      tool: "searchAgencies",
      reason: reasonFor("searchAgencies", "Retrieve verified consulting agencies."),
      gated: true,
      allowed: wantsAgencies && agencyGate(query),
    },
  ];

  // Record where governance overruled the model — this is the audit value.
  for (const p of proposed) {
    if (!isToolName(p.tool)) {
      issues.push(`Dropped unregistered tool "${p.tool}".`);
      continue;
    }
    const decided = tools.find((t) => t.tool === p.tool);
    if (decided && !decided.allowed) {
      issues.push(`Tool "${p.tool}" was planned but vetoed: no gated section earned it.`);
    }
  }
  return { tools, issues };
}

// Risk checks are COMPUTED from the deterministic controls, never authored by the
// planner. `triggered` = the risk was live for this run; `action` = what the
// controls did about it.
function deriveRiskChecks(
  proposedSections: SectionName[],
  finalSections: SectionName[],
  query: string
): RiskCheckDecision[] {
  const proposedAgencies = proposedSections.includes("agencies");
  const finalAgencies = finalSections.includes("agencies");
  const gatePassed = agencyGate(query);

  const hasLinks = finalSections.includes("resources") || finalSections.includes("courses");
  const hasFreeText = (["ai_suggestion", "roadmap", "skill_focus", "next_steps"] as SectionName[]).some(
    (s) => finalSections.includes(s)
  );

  return [
    {
      check: "agency_push",
      triggered: proposedAgencies,
      action: finalAgencies ? "allow" : "veto",
      note: !proposedAgencies
        ? "Planner did not request agencies."
        : finalAgencies
          ? "Query explicitly names a provider; agencyGate passed."
          : gatePassed
            ? "agencyGate passed but the section was not planned."
            : "agencyGate VETOED: query names no human provider.",
    },
    {
      check: "unverified_links",
      triggered: hasLinks,
      action: "allow",
      note: hasLinks
        ? "Links restricted to verified DB rows with http source URLs; the model cannot author links."
        : "No link sections planned.",
    },
    {
      check: "invented_provider",
      triggered: hasFreeText,
      action: "allow",
      note: hasFreeText
        ? "Enforced downstream: verification removes prose naming a provider no verified record backs."
        : "No free-text sections planned.",
    },
    {
      check: "guarantees",
      triggered: hasFreeText,
      action: "allow",
      note: hasFreeText
        ? "Enforced by prompt rule and the verification soft check; no guaranteed jobs/interviews/salaries."
        : "No free-text sections planned.",
    },
  ];
}

// Validate a proposal against the registry and the gates, returning BOTH the rich
// ExecutionPlan and the existing `plan: AgentPlan` the rest of the graph and the
// API already consume. `plan` is derived through the untouched finalizePlan(), so
// gating behaviour cannot drift between the old and new planner.
export function finalizeExecutionPlan(
  proposal: PlannerProposal,
  query: string,
  degraded: boolean
): { executionPlan: ExecutionPlan; plan: AgentPlan } {
  const planIssues: string[] = [];

  // 1. Context — drop unregistered names.
  const requiredContext: ContextRequirement[] = [];
  for (const c of proposal.requiredContext) {
    if (isContextRequirement(c)) requiredContext.push(c);
    else planIssues.push(`Dropped unregistered context requirement "${c}".`);
  }

  // 2. Agents — drop unregistered, then force the structurally required ones back
  // in. The planner does not get to silently drop the verifier.
  const agents: AgentName[] = [];
  for (const a of proposal.agents) {
    if (isAgentName(a)) {
      if (!agents.includes(a)) agents.push(a);
    } else planIssues.push(`Dropped unregistered agent "${a}".`);
  }
  for (const m of MANDATORY_AGENTS) {
    if (!agents.includes(m)) {
      agents.push(m);
      planIssues.push(`Forced required agent "${m}" back into the plan.`);
    }
  }

  // 3. Sections — drop unregistered, then apply the EXISTING gates.
  const proposedSections: SectionName[] = [];
  for (const s of proposal.expectedSections) {
    if (SECTION_SET.has(s)) {
      if (!proposedSections.includes(s as SectionName)) proposedSections.push(s as SectionName);
    } else planIssues.push(`Dropped unregistered section "${s}".`);
  }
  const plan = finalizePlan(needsFromSections(proposedSections, proposal.reasoning), query);
  for (const s of proposedSections) {
    if (!plan.sections.includes(s)) planIssues.push(`Section "${s}" was proposed but gated out.`);
  }

  // 4. Tools — derived from the GATED sections, so plan and retrieval agree.
  const { tools, issues: toolIssues } = deriveTools(plan.sections, proposal.tools, query);
  planIssues.push(...toolIssues);

  const executionPlan: ExecutionPlan = {
    goal: proposal.goal,
    requiredContext,
    agents,
    tools,
    riskChecks: deriveRiskChecks(proposedSections, plan.sections, query),
    // Post-gate, so the artifact never advertises a section the run will not emit.
    expectedSections: plan.sections,
    reasoning: proposal.reasoning,
    degraded,
    planIssues,
  };

  return { executionPlan, plan };
}
