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

// Derive how the run ended from what verification concluded.
//
// Phase 1 reaches only `approved` / `corrected` / `failed`: rejection is terminal
// (the corrected answer ships anyway), so there is no regeneration or safe-text
// fallback yet. `regenerated` and `fallback` become reachable in Phase 3.
export function deriveFinalStatus(state: AgentStateType): FinalStatus {
  const v = state.verificationResult;
  if (!v) return "failed"; // verification never produced a verdict
  return v.approved ? "approved" : "corrected";
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
      trace: state.trace,
      finalStatus: deriveFinalStatus(state),
      recommendationId: state.recommendationId,
      executionPlan: state.executionPlan,
    });
  } catch (error) {
    console.error("Agent trace persistence failed:", error);
  }
  return {};
}
