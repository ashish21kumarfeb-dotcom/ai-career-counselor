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
      traced("career_data_agent", "tool", careerDataAgentNode, (p) => {
        // Transport is REPORTED by the agent (toolCalls), not inferred here. A
        // tool that fell back to a direct call because the MCP server was down is
        // a degraded run, and the trace is the only thing standing between that
        // and a demo claiming "runs on MCP".
        const cd = p.careerData;
        const calls = cd?.toolCalls ?? [];
        const ran = calls.filter((c) => c.transport !== "skipped");
        const fellBack = ran.filter((c) => c.degradedReason);
        // toolMode is the run-level transport verdict a demo can be judged on:
        // "mcp" only if EVERY tool that ran went over the protocol; "mixed" if some
        // fell back; "direct" if all did; "none" if the plan earned no tool.
        const transports = new Set(ran.map((c) => c.transport));
        const toolMode =
          ran.length === 0 ? "none" : transports.size > 1 ? "mixed" : ([...transports][0] ?? "none");
        const external =
          (cd?.roadmaps?.length ?? 0) + (cd?.marketSignals?.length ?? 0) + (cd?.industryArticles?.length ?? 0);
        return {
          status: fellBack.length > 0 ? "degraded" : "ok",
          summary:
            `rag: ${cd?.ragDocs.length ?? 0}, agencies: ${cd?.agencies.length ?? 0}, resources: ${cd?.resources.length ?? 0}, courses: ${cd?.courses.length ?? 0}, external: ${external}` +
            (fellBack.length ? ` | MCP unavailable, ${fellBack.length} tool(s) fell back to direct` : ""),
          detail: {
            // Demo-safety fields: the run's own answer to "did the tools really run
            // over MCP, how long did they take, and did anything fall back?"
            toolMode,
            toolsCalled: ran.map((c) => c.tool),
            latencyMs: cd?.toolLatencyMs ?? 0,
            degraded: fellBack.length > 0,
            fallbackReason: fellBack.map((c) => c.degradedReason).join("; ") || null,
            toolCalls: calls.map((c) => `${c.tool}:${c.transport}${c.degradedReason ? " (degraded)" : ""}`),
            degradedReasons: fellBack.map((c) => c.degradedReason),
            external: {
              roadmaps: cd?.roadmaps?.length ?? 0,
              marketSignals: cd?.marketSignals?.length ?? 0,
              industryArticles: cd?.industryArticles?.length ?? 0,
            },
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
        const d = p.recommendation?.draftSections ?? {};
        const drafted = Object.keys(d);

        // runRecommendationAgent SWALLOWS an LLM failure and assembles DB sections
        // only, so a planned text section still appears — as an empty string or an
        // empty array. Reporting that as "ok" is precisely the silent degradation
        // this trace exists to catch: the section key is there, the content is not.
        const planned = s.plan?.sections ?? [];
        const emptyText = [
          planned.includes("ai_suggestion") && !d.ai_suggestion?.trim(),
          planned.includes("roadmap") && (d.roadmap?.items.length ?? 0) === 0,
          planned.includes("skill_focus") && (d.skill_focus?.length ?? 0) === 0,
          planned.includes("next_steps") && (d.next_steps?.length ?? 0) === 0,
        ].filter(Boolean).length;

        return {
          type: isRegen ? "regeneration" : "agent",
          status: emptyText > 0 ? "degraded" : "ok",
          summary:
            (isRegen ? `regenerated after rejection: ${drafted.join(", ") || "(none)"}` : `drafted: ${drafted.join(", ") || "(none)"}`) +
            (emptyText > 0 ? ` | ${emptyText} planned text section(s) came back EMPTY — text generation failed` : ""),
          detail: {
            draftSections: drafted,
            emptyPlannedTextSections: emptyText,
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
      // Status is REPORTED by the node, not inferred from state.persist. The old
      // summarizer could only see "did we intend to run?", so a rate-limited
      // extraction — which extractMemories swallowed into an empty array — traced
      // as "memory extraction run", ok. Memory is best-effort, but a trace that
      // quietly reports a failure as a success is the one thing it must not do.
      traced("update_memory", "agent", memoryNode, (p) => {
        const m = p.memoryUpdate;
        if (!m || m.status === "skipped") {
          return { status: "skipped", summary: "skipped (persist:false)" };
        }
        if (m.status === "failed") {
          return {
            status: "degraded",
            summary: `memory update FAILED — nothing stored${m.factsWritten > 0 ? ` after ${m.factsWritten} write(s)` : ""}`,
            detail: { error: m.error, factsExtracted: m.factsExtracted, factsWritten: m.factsWritten },
          };
        }
        return {
          status: "ok",
          // 0 facts is a real result, not a failure: most messages state nothing durable.
          summary: m.factsWritten > 0
            ? `${m.factsWritten} durable fact(s) stored`
            : "no durable facts in this message",
          detail: { factsExtracted: m.factsExtracted, factsWritten: m.factsWritten },
        };
      })
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
