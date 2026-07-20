// Resolve-query node: the FIRST node in the graph. It rewrites a follow-up message
// into a standalone question using the active conversation (state.history), then
// OVERWRITES state.query with the resolved form. `query` is the single channel every
// downstream stage reads (intent, planner + regex gates, retrieval tokenizer,
// generation, memory), so resolution propagates to all of them with no per-stage
// changes. The raw text is preserved on originalQuery for audit/trace.
//
// Fault-tolerant: resolveQuery never throws and falls back to the original query, so
// on any failure the pipeline runs exactly as it did before this node existed.
import { resolveQuery } from "../../ai/resolveQuery";
import type { AgentStateType } from "../state";

export async function resolveQueryNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  const resolved = await resolveQuery(state.query, state.history);
  return { query: resolved, originalQuery: state.query };
}
