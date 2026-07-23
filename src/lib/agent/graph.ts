// The agentic-chat graph, an explicit multi-agent (internal A2A) flow:
// START -> input guardrail -> resolve query -> Profile Agent -> intent ->
// planner -> Career Data Agent -> Recommendation Agent -> Verification Agent ->
// memory -> evaluate -> log -> END.
// (A blocked input short-circuits: guardrail -> persist trace -> END.)
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
import { resolveQueryNode } from "./nodes/resolveQuery";
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
import { inputGuardrailNode } from "./nodes/inputGuardrail";
import { shadowCompare } from "./lanes";
import { agentConfig } from "./config";
import type { AgentStateType } from "./state";

// Where a run goes after the input guardrail. Blocked runs short-circuit
// straight to persist_trace: no LLM calls, no retrieval, no memory or logged
// answer — but a recorded agent_runs row with finalStatus "blocked". A missing
// result routes "ok": the screen is fail-open by design (a false block loses a
// legitimate question; a false allow lands on the real defenses downstream —
// see src/lib/chat/screen.ts). Exported for tests.
export function routeAfterGuardrail(state: AgentStateType): "ok" | "blocked" {
  return state.guardrail?.blocked ? "blocked" : "ok";
}

// Where a run goes after verification. Pure and total, so the loop's termination
// is a property of this function rather than of the graph's shape:
//   approved                          -> proceed (first pass or a successful retry)
//   rejected + evidence insufficient  -> back to the PLANNER (re-plan, re-retrieve)
//   rejected, retries remaining       -> regenerate with the verifier's feedback
//   rejected, retries exhausted       -> stop trying; ship a safe fallback
// Replan is checked BEFORE regenerate: when verification says the evidence is
// missing, regenerating against the same evidence is wasted spend.
// Budgets come from agentConfig (AGENT_MAX_REGENERATIONS default 2 clamp 0-3;
// AGENT_MAX_REPLANS default 1 clamp 0-2). Worst case with defaults: 2 planner
// calls, retrieval twice, and up to 4 generation+verification passes — bounded
// because both counters only ever increase. Exported for tests;
// MAX_REGENERATIONS is kept as a config-backed alias for existing importers.
export const MAX_REGENERATIONS = agentConfig.maxRegenerations;

export function routeAfterVerification(
  state: AgentStateType
): "proceed" | "regenerate" | "replan" | "fallback" {
  if (state.verificationResult?.approved) return "proceed";
  // No verdict at all means verification itself failed; regenerating would be
  // guesswork, so take the safe branch rather than loop.
  if (!state.verificationResult) return "fallback";
  if (
    state.verificationResult.needsMoreContext &&
    state.replanAttempts < agentConfig.maxReplans
  ) {
    return "replan";
  }
  return state.regenerationAttempts < agentConfig.maxRegenerations
    ? "regenerate"
    : "fallback";
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
      "input_guardrail",
      // Deterministic input screen, now a traced pipeline stage. A block is a
      // SUCCESSFUL guardrail action, but it is traced as "degraded" rather than
      // "ok" so blocked runs are loud in the trace without claiming the node
      // itself broke.
      traced("input_guardrail", "guardrail", inputGuardrailNode, (p) => {
        const g = p.guardrail;
        return g?.blocked
          ? {
              status: "degraded",
              summary: `blocked: ${g.reason} (in ${g.where})`,
              detail: { blocked: true, reason: g.reason, where: g.where },
            }
          : { summary: "clean", detail: { blocked: false } };
      })
    )
    .addNode(
      "resolve_query",
      // Context-aware query resolution: rewrites a follow-up into a standalone
      // question using the active conversation, so intent/planner/retrieval/
      // generation all act on the resolved form. The trace records what the
      // follow-up was expanded to (or that it was left as-is).
      traced("resolve_query", "intent", resolveQueryNode, (p) => {
        const rewrote = !!p.originalQuery && p.originalQuery !== p.query;
        return {
          summary: rewrote
            ? `rewrote follow-up: ${JSON.stringify(p.originalQuery)} -> ${JSON.stringify(p.query)}`
            : "standalone query (no rewrite)",
          detail: { originalQuery: p.originalQuery, resolvedQuery: p.query, rewrote },
        };
      })
    )
    .addNode(
      "extract_intent",
      traced("extract_intent", "intent", intentNode, (p, s) => {
        // SHADOW-MODE lane comparison: record what the slots WOULD decide next
        // to what the regex gates DO decide, so the slots-primary rollout is a
        // data-driven flip instead of a leap. Behavior is unchanged — the gates
        // still govern; this detail is the evidence for switching.
        const shadow = p.intentSlots
          ? shadowCompare(s.query, { intent: p.intent ?? "other", slots: p.intentSlots, degraded: false })
          : undefined;
        return {
          status: p.intentSlots ? "ok" : "degraded",
          summary:
            `intent: ${p.intent}` +
            (p.intentSlots ? "" : " | slot extraction unavailable (label-only fallback)") +
            (shadow && !shadow.agree ? " | shadow lanes DISAGREE with regex gates" : ""),
          detail: {
            intent: p.intent,
            slots: p.intentSlots,
            shadowLanes: shadow,
          },
        };
      })
    )
    .addNode(
      "planner",
      traced("planner", "plan", plannerNode, (p, s) => {
        // The planner is fault-tolerant: on LLM/parse failure it falls back to a
        // gate-safe regex plan. That fallback is a DEGRADED run, not a successful
        // one — `degraded` is now an explicit field rather than something to be
        // inferred from a reasoning string.
        const ep = p.executionPlan;
        const vetoed = ep?.riskChecks.filter((r) => r.action === "veto") ?? [];
        // Second pass: verification sent the run back for more evidence. Same
        // idiom as the recommendation summarizer's isRegen — the loop must be
        // legible in the trace. Re-typed "regeneration" (the loop vocabulary):
        // a replan is the plan stage run again, not a new kind of stage.
        const isReplan = (p.replanAttempts ?? 0) > s.replanAttempts;
        return {
          type: isReplan ? "regeneration" : "plan",
          status: ep?.degraded ? "degraded" : "ok",
          summary:
            (isReplan ? "RE-PLANNED after verification (insufficient evidence) — " : "") +
            `goal: ${ep?.goal ?? "(none)"} | sections: ${p.plan?.sections.join(", ") ?? "(none)"}`,
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
            // On a replan pass: what evidence the previous pass was missing.
            replanned: isReplan || undefined,
            missingContext: isReplan ? p.plannerFeedback?.missingContext : undefined,
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
            // WHICH figure failed grounding, not merely that one did — the trace is
            // the only place a reviewer can see what the gate actually caught.
            unsupportedClaims: v?.unsupportedClaims ?? [],
            issues: v?.issues ?? [],
            // The re-planning signal: rejection because the EVIDENCE was thin,
            // not because the draft was wrong.
            needsMoreContext: v?.needsMoreContext ?? false,
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
      traced("safe_fallback", "regeneration", safeFallbackNode, (_p, s) => ({
        status: "degraded",
        summary: `rejected after ${s.regenerationAttempts + 1} attempt(s) — free text replaced with a safe summary; verified sections kept`,
      }))
    )
    // Terminal trace flush. Untraced by design — see nodes/persistTrace.ts.
    .addNode("persist_trace", persistTraceNode)
    .addEdge(START, "input_guardrail")
    // Blocked input never reaches a model or the DB tools; the run records
    // itself (persist_trace) and ends. Clean input proceeds unchanged.
    .addConditionalEdges("input_guardrail", routeAfterGuardrail, {
      ok: "resolve_query",
      blocked: "persist_trace",
    })
    // The Profile Agent runs BEFORE intent extraction and planning: who the user
    // is is context FOR both, not a consequence of them. It is deterministic and
    // depends on nothing but userId, so moving it earlier costs nothing.
    .addEdge("resolve_query", "profile_agent")
    .addEdge("profile_agent", "extract_intent")
    .addEdge("extract_intent", "planner")
    .addEdge("planner", "career_data_agent")
    .addEdge("career_data_agent", "recommendation_agent")
    .addEdge("recommendation_agent", "verification_agent")
    // THE LOOP. Verification can send a draft back instead of merely correcting
    // it and shipping. At most agentConfig.maxRegenerations retries:
    // routeAfterVerification is the guard, and it is a pure function of state so
    // every branch is unit-testable.
    // Note the retry edge targets recommendation_agent, NOT career_data_agent —
    // retrieval is not repeated.
    .addConditionalEdges("verification_agent", routeAfterVerification, {
      regenerate: "recommendation_agent",
      // Insufficient evidence: back to the planner for a full re-plan +
      // re-retrieval pass (unlike regenerate, retrieval IS repeated — that is
      // the point).
      replan: "planner",
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
