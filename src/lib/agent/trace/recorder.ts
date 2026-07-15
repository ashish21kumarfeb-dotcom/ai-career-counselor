// Trace recording: a thin wrapper that turns any existing graph node into a
// traced one WITHOUT editing the node.
//
// Design: the nodes stay untouched. `traced()` wraps a node at wire-time in
// graph.ts, times it, and derives one TraceEvent from the Partial the node
// returned via a per-node `summarize` function. All trace semantics therefore
// live in one place (graph.ts) instead of being smeared across nine nodes, and
// a node cannot forget to emit an event.
//
// This relies on the `trace` channel using an APPEND reducer (see state.ts) —
// every other channel in this graph is last-value-wins.
import type { AgentStateType } from "../state";
import type { TraceEvent, TraceEventType, TraceStatus } from "./types";

// Detail is for evidence, not for payloads. A whole LLM response or document
// here would bloat the agent_runs jsonb column on every run.
const MAX_STRING_CHARS = 300;
const MAX_DETAIL_CHARS = 2000;

function truncate(value: string): string {
  return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS - 1)}…` : value;
}

// Shallow-bound a detail object: truncate long strings, then hard-cap the whole
// serialized size. Never throws — detail must never be able to break a run.
export function boundDetail(
  detail: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  try {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(detail)) {
      if (typeof value === "string") out[key] = truncate(value);
      else if (Array.isArray(value)) {
        out[key] = value.map((v) => (typeof v === "string" ? truncate(v) : v));
      } else out[key] = value;
    }
    const serialized = JSON.stringify(out);
    if (serialized && serialized.length > MAX_DETAIL_CHARS) {
      return { truncated: true, bytes: serialized.length };
    }
    return out;
  } catch {
    // Circular or non-serializable detail: record that, not the object.
    return { unserializable: true };
  }
}

export type NodeFn = (state: AgentStateType) => Promise<Partial<AgentStateType>>;

// What a node's result means, in trace terms. Returning no status means "ok".
//
// `type` may be overridden per-run: the recommendation node is an "agent" on its
// first pass and a "regeneration" on its second, and a reader of the trace should
// be able to see the loop without correlating step names by hand.
export type TraceSummary = {
  status?: TraceStatus;
  type?: TraceEventType;
  summary: string;
  detail?: Record<string, unknown>;
};

export type SummarizeFn = (
  partial: Partial<AgentStateType>,
  state: AgentStateType
) => TraceSummary;

export function makeEvent(
  seq: number,
  step: string,
  type: TraceEventType,
  status: TraceStatus,
  durationMs: number,
  summary: string,
  detail?: Record<string, unknown>
): TraceEvent {
  return {
    seq,
    at: new Date().toISOString(),
    step,
    type,
    status,
    durationMs,
    summary,
    detail: boundDetail(detail),
  };
}

// Wrap a node so it records exactly one TraceEvent.
//
// `seq` is derived from state.trace.length, which is correct for this graph
// because it is strictly sequential — no node runs concurrently with another.
// If the graph ever fans out, seq would race and should move to a counter.
//
// On throw: the event is recorded to console and the error is RE-THROWN. It is
// not swallowed, because swallowing would change /api/agent-chat's behaviour
// (its 502 path) and Phase 1 is contractually additive. The route persists a
// `failed` run row instead — see api/agent-chat/route.ts.
export function traced(
  step: string,
  type: TraceEventType,
  node: NodeFn,
  summarize: SummarizeFn
): NodeFn {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => {
    const startedAt = Date.now();
    const seq = state.trace.length;
    try {
      const partial = await node(state);
      let s: TraceSummary;
      try {
        s = summarize(partial, state);
      } catch (error) {
        // A broken summarizer must never break the run it is observing.
        s = { status: "degraded", summary: `trace summarize failed for ${step}`, detail: { error: String(error) } };
      }
      const event = makeEvent(
        seq,
        step,
        s.type ?? type,
        s.status ?? "ok",
        Date.now() - startedAt,
        s.summary,
        s.detail
      );
      return { ...partial, trace: [event] };
    } catch (error) {
      console.error(`[trace] ${step} threw after ${Date.now() - startedAt}ms:`, error);
      throw error;
    }
  };
}
