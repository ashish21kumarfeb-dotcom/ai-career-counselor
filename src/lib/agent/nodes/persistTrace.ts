// Trace flush — the LAST node in the graph, and deliberately NOT wrapped in
// traced().
//
// Why not traced: the traced() wrapper appends a node's event only AFTER that
// node returns, so any node that persists the trace cannot include its own event.
// Rather than persist a knowingly-incomplete trace from inside log_turn, the
// flush is a separate terminal node. It is infrastructure — the recorder writing
// out — not a step of the workflow, so it correctly has no event of its own.
//
// Never throws: a trace write must not be able to break a response that the user
// is already owed. A failed flush is logged and the run proceeds.
import { saveRun } from "../trace/queries";
import type { FinalStatus } from "../trace/types";
import type { AgentStateType } from "../state";

// Derive how the run ended from what verification concluded and whether the
// regeneration loop was used. Mirrors routeAfterVerification in graph.ts — if
// that router changes, this must too, or the trace will misreport the ending.
//
//   blocked     — the input guardrail stopped the run; nothing downstream ran.
//   failed      — verification never produced a verdict.
//   approved    — passed first time.
//   replanned   — verification sent the run back to the planner (re-plan +
//                 re-retrieval), and the re-planned pass was approved. Wins over
//                 "regenerated": it is the stronger, more expensive intervention.
//   regenerated — was rejected, regenerated at least once, then passed.
//   fallback    — still rejected after every allowed retry; safe summary shipped.
//
// `corrected` is NOT produced any more. It was the Phase 1 ending, when
// rejection was terminal and the corrected answer shipped regardless; the loop
// replaces that path entirely. The value stays in FINAL_STATUSES and the pg enum
// because Phase 1 rows still carry it (and Postgres cannot safely drop an in-use
// enum value).
export function deriveFinalStatus(state: AgentStateType): FinalStatus {
  // Checked first: a blocked run has no verdict by construction and would
  // otherwise misreport as "failed".
  if (state.guardrail?.blocked) return "blocked";
  const v = state.verificationResult;
  if (!v) return "failed";
  if (v.approved) {
    if (state.replanAttempts > 0) return "replanned";
    return state.regenerationAttempts > 0 ? "regenerated" : "approved";
  }
  return "fallback";
}

export async function persistTraceNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  if (!state.persist) return {};
  if (!state.runId) {
    // No correlation id supplied: the caller opted out of tracing (or a test
    // invoked the graph directly). Recording a run we cannot correlate is worse
    // than not recording it.
    console.warn("[trace] no runId on state; skipping agent_runs write.");
    return {};
  }

  try {
    await saveRun({
      runId: state.runId,
      userId: state.userId,
      query: state.query,
      intent: state.intent,
      intentSlots: state.intentSlots,
      trace: state.trace,
      finalStatus: deriveFinalStatus(state),
      recommendationId: state.recommendationId,
      // Empty for a direct/partial invocation (tests); the column is nullable.
      conversationId: state.conversationId || undefined,
      executionPlan: state.executionPlan,
    });
  } catch (error) {
    console.error("Agent trace persistence failed:", error);
  }
  return {};
}
