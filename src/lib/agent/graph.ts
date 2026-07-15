// The agentic-chat graph, an explicit multi-agent (internal A2A) flow:
// START -> intent -> planner -> Profile Agent -> Career Data Agent ->
// Recommendation Agent -> Verification Agent -> memory -> evaluate -> log -> END.
// Exposed via /api/agent-chat. Compiled once and reused.
//
// The four agents are standalone cores (src/lib/agent/agents/*) wrapped by thin
// nodes that pass typed DTO envelopes between them (see each node for the explicit
// hand-off). The memory / evaluate / log nodes are unchanged — the agent nodes keep
// their backward-compat state channels populated.
//
// AUDIT TRACE: every node is wrapped in `traced()`, which times it and derives one
// TraceEvent from what the node returned. The nodes themselves are untouched and
// know nothing about tracing — all trace semantics live in the summarizers below,
// so there is exactly one place to read to learn what this workflow records. The
// events accumulate on the `trace` channel (the graph's only append reducer) and
// the log node persists them to agent_runs.
import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState } from "./state";
import { traced } from "./trace/recorder";
import { intentNode } from "./nodes/intent";
import { plannerNode } from "./nodes/planner";
import { profileAgentNode } from "./nodes/profileAgent";
import { careerDataAgentNode } from "./nodes/careerDataAgent";
import { recommendationAgentNode } from "./nodes/recommendationAgent";
import { verificationAgentNode } from "./nodes/verificationAgent";
import { memoryNode } from "./nodes/memory";
import { evaluateNode } from "./nodes/evaluate";
import { logNode } from "./nodes/log";
import { persistTraceNode } from "./nodes/persistTrace";
import { safeFallbackNode } from "./nodes/safeFallback";
import type { AgentStateType } from "./state";

// Where a run goes after verification. Pure and total, so the loop's termination
// is a property of this function rather than of the graph's shape:
//   approved                  -> proceed (first pass or a successful retry)
//   rejected, no retry yet    -> regenerate with the verifier's feedback
//   rejected, already retried -> stop trying; ship a safe fallback
// Exported for tests.
export const MAX_REGENERATIONS = 1;

export function routeAfterVerification(
  state: AgentStateType
): "proceed" | "regenerate" | "fallback" {
  if (state.verificationResult?.approved) return "proceed";
  // No verdict at all means verification itself failed; regenerating would be
  // guesswork, so take the safe branch rather than loop.
  if (!state.verificationResult) return "fallback";
  return state.regenerationAttempts < MAX_REGENERATIONS ? "regenerate" : "fallback";
}

// Verification is the only node whose OUTPUT decides routing, so it is
// injectable — the loop cannot otherwise be tested without waiting for the model
// to produce a genuinely bad draft. Same dependency-injection pattern as
// runVerificationAgent's opts.softCheck: the real graph is exercised, only the
// verdict is stubbed.
export type GraphOverrides = {
  verificationNode?: (state: AgentStateType) => Promise<Partial<AgentStateType>>;
};

export function buildAgentGraph(overrides: GraphOverrides = {}) {
  const verification = overrides.verificationNode ?? verificationAgentNode;
  // Node names must not collide with state channel names.
  return new StateGraph(AgentState)
    .addNode(
      "extract_intent",
      traced("extract_intent", "intent", intentNode, (p) => ({
        summary: `intent: ${p.intent}`,
        detail: { intent: p.intent },
      }))
    )
    .addNode(
      "planner",
      traced("planner", "plan", plannerNode, (p) => {
        // The planner is fault-tolerant: on LLM/parse failure it falls back to a
        // gate-safe regex plan. That fallback is a DEGRADED run, not a successful
        // one — `degraded` is now an explicit field rather than something to be
        // inferred from a reasoning string.
        const ep = p.executionPlan;
        const vetoed = ep?.riskChecks.filter((r) => r.action === "veto") ?? [];
        return {
          status: ep?.degraded ? "degraded" : "ok",
          summary: `goal: ${ep?.goal ?? "(none)"} | sections: ${p.plan?.sections.join(", ") ?? "(none)"}`,
          detail: {
            goal: ep?.goal,
            sections: p.plan?.sections,
            agents: ep?.agents,
            toolsAllowed: ep?.tools.filter((t) => t.allowed).map((t) => t.tool),
            toolsVetoed: ep?.tools.filter((t) => !t.allowed).map((t) => t.tool),
            risksVetoed: vetoed.map((r) => r.check),
            // Where governance overruled the model. The audit value of the run.
            planIssues: ep?.planIssues ?? [],
            degraded: ep?.degraded,
            reasoning: ep?.reasoning,
          },
        };
      })
    )
    .addNode(
      "profile_agent",
      traced("profile_agent", "agent", profileAgentNode, (p) => ({
        summary: p.profile ? "profile loaded" : "no profile on file",
        detail: {
          hasProfile: !!p.profile,
          memoryItems: p.memory?.length ?? 0,
          constraints: p.profileAgent?.importantConstraints.length ?? 0,
        },
      }))
    )
    .addNode(
      "career_data_agent",
      traced("career_data_agent", "tool", careerDataAgentNode, (p, s) => {
        // Which tools actually ran is inferred from the plan vs. what came back:
        // a planned-but-empty section means the tool ran and found nothing; a
        // section that was never planned means the gate vetoed the tool. Phase 4
        // replaces this inference with the tool registry's own report.
        const planned = s.plan?.sections ?? [];
        const cd = p.careerData;
        return {
          summary: `rag: ${cd?.ragDocs.length ?? 0}, agencies: ${cd?.agencies.length ?? 0}, resources: ${cd?.resources.length ?? 0}, courses: ${cd?.courses.length ?? 0}`,
          detail: {
            transport: "direct", // Phase 4: "mcp" | "direct"
            agencyToolRan: planned.includes("agencies"),
            resourceToolRan: planned.includes("resources") || planned.includes("courses"),
            missingDataNotes: cd?.missingDataNotes ?? [],
          },
        };
      })
    )
    .addNode(
      "recommendation_agent",
      traced("recommendation_agent", "agent", recommendationAgentNode, (p, s) => {
        // Second pass: re-typed as "regeneration" so the loop is visible in the
        // trace without correlating repeated step names by hand.
        const isRegen = (p.regenerationAttempts ?? 0) > s.regenerationAttempts;
        const drafted = Object.keys(p.recommendation?.draftSections ?? {});
        return {
          type: isRegen ? "regeneration" : "agent",
          summary: isRegen
            ? `regenerated after rejection: ${drafted.join(", ") || "(none)"}`
            : `drafted: ${drafted.join(", ") || "(none)"}`,
          detail: {
            draftSections: drafted,
            attempt: (p.regenerationAttempts ?? 0) + 1,
            actingOnIssues: isRegen ? s.verificationResult?.issues : undefined,
          },
        };
      })
    )
    .addNode(
      "verification_agent",
      traced("verification_agent", "verification", verification, (p) => {
        const v = p.verificationResult;
        // An unavailable soft check is degraded, NOT ok: grounded/safe are
        // reported false-because-unconfirmed, and the run must say so.
        const status = !v ? "failed" : !v.softCheckAvailable || !v.approved ? "degraded" : "ok";
        return {
          status,
          summary: v?.approved ? "approved" : `corrections applied: ${v?.issues.length ?? 0} issue(s)`,
          detail: {
            approved: v?.approved,
            grounded: v?.grounded,
            safe: v?.safe,
            softCheckAvailable: v?.softCheckAvailable,
            issues: v?.issues ?? [],
          },
        };
      })
    )
    .addNode(
      "update_memory",
      traced("update_memory", "agent", memoryNode, (_p, s) => ({
        status: s.persist ? "ok" : "skipped",
        summary: s.persist ? "memory extraction run" : "skipped (persist:false)",
      }))
    )
    .addNode(
      "evaluate",
      traced("evaluate", "evaluation", evaluateNode, (p) => ({
        // The evaluator swallows its own failures and returns no score, so a
        // missing evaluation is a degraded run rather than a clean one.
        status: p.evaluation ? "ok" : "degraded",
        summary: p.evaluation
          ? `overall ${p.evaluation.overall}/10 (hallucination risk: ${p.evaluation.hallucination_risk})`
          : "evaluation unavailable",
        detail: p.evaluation ? { ...p.evaluation } : undefined,
      }))
    )
    .addNode(
      "log_turn",
      traced("log_turn", "output", logNode, (_p, s) => ({
        status: s.persist ? "ok" : "skipped",
        summary: s.persist ? "turn logged" : "skipped (persist:false)",
      }))
    )
    .addNode(
      "safe_fallback",
      traced("safe_fallback", "regeneration", safeFallbackNode, () => ({
        status: "degraded",
        summary: "rejected twice — free text replaced with a safe summary; verified sections kept",
      }))
    )
    // Terminal trace flush. Untraced by design — see nodes/persistTrace.ts.
    .addNode("persist_trace", persistTraceNode)
    .addEdge(START, "extract_intent")
    .addEdge("extract_intent", "planner")
    .addEdge("planner", "profile_agent")
    .addEdge("profile_agent", "career_data_agent")
    .addEdge("career_data_agent", "recommendation_agent")
    .addEdge("recommendation_agent", "verification_agent")
    // THE LOOP. Verification can send a draft back instead of merely correcting
    // it and shipping. Exactly one retry: routeAfterVerification is the guard,
    // and it is a pure function of state so every branch is unit-testable.
    // Note the retry edge targets recommendation_agent, NOT career_data_agent —
    // retrieval is not repeated.
    .addConditionalEdges("verification_agent", routeAfterVerification, {
      regenerate: "recommendation_agent",
      fallback: "safe_fallback",
      proceed: "update_memory",
    })
    .addEdge("safe_fallback", "update_memory")
    .addEdge("update_memory", "evaluate")
    .addEdge("evaluate", "log_turn")
    .addEdge("log_turn", "persist_trace")
    .addEdge("persist_trace", END)
    .compile();
}

// Reusable compiled graph.
export const agentGraph = buildAgentGraph();
