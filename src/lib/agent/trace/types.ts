// Audit-trace contract for a single /api/agent-chat run.
//
// Why this exists: the only observability the graph had was `logHandoff()` in
// a2a.ts — a console.log that early-returns to a no-op when NODE_ENV is
// "production". There was no run id, no timing, no correlation across hops, and
// nothing persisted. Nothing recorded WHY the workflow did what it did.
//
// The trace is deliberately the anti-overclaim mechanism: every honest label we
// use about this system ("the gate vetoed the tool", "the tool ran over MCP",
// "the soft check was unavailable") must be visible as a recorded event, or we
// do not get to say it. Degradation is recorded as loudly as success.

// What produced the event. Mirrors the pipeline stages rather than node names so
// the vocabulary survives a node rename.
export const TRACE_EVENT_TYPES = [
  "guardrail",
  "intent",
  "plan",
  "agent",
  "tool",
  "verification",
  "regeneration",
  "evaluation",
  "output",
] as const;
export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];

// "ok"       — did what it was supposed to.
// "degraded" — produced a usable result on a fallback path (planner LLM failed,
//              soft check unavailable, MCP down -> direct call). NOT a success.
// "skipped"  — deliberately not run (gate vetoed, plan did not ask for it).
// "failed"   — threw. The graph is fault-tolerant, so this rarely stops the run.
export const TRACE_STATUSES = ["ok", "degraded", "skipped", "failed"] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

export type TraceEvent = {
  seq: number;
  at: string; // ISO timestamp
  step: string; // graph node name
  type: TraceEventType;
  status: TraceStatus;
  durationMs: number;
  summary: string;
  // Structured, BOUNDED extra context. Never put a full LLM response or a whole
  // document here — see boundDetail() in recorder.ts.
  detail?: Record<string, unknown>;
};

// How the run ended. Kept in sync with the `run_status` pgEnum in db/schema.ts.
//
// "corrected" is not in the approved plan's list, which went straight from
// "approved" to "regenerated". It is added because it is the state Phase 1
// actually reaches: verification sanitizes a draft, sets approved:false, and the
// corrected answer ships anyway (rejection is terminal until Phase 3 adds the
// loop). Folding that into "fallback" would misreport a corrected answer as a
// safe-text fallback — precisely the overclaim this trace exists to prevent.
//   approved    — passed verification clean.
//   corrected   — hard issues sanitized out; corrected answer shipped.
//   regenerated — rejected, regenerated (>=1 retry), then passed.          (Phase 3)
//   fallback    — rejected on every allowed attempt; safe summary shipped. (Phase 3)
//   failed      — the run threw.
//   blocked     — the input guardrail stopped the run at the door. No LLM call
//                 was made and no answer was produced; the trace row IS the
//                 record of the attempt.
//   replanned   — verification judged the evidence insufficient, the run went
//                 back to the planner (re-plan + re-retrieval), then passed.
export const FINAL_STATUSES = [
  "approved",
  "corrected",
  "regenerated",
  "fallback",
  "failed",
  "blocked",
  "replanned",
] as const;
export type FinalStatus = (typeof FINAL_STATUSES)[number];

export type RunTrace = {
  runId: string;
  events: TraceEvent[];
  finalStatus: FinalStatus;
};
