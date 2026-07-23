// Input guardrail — the FIRST node in the graph, so screening is a traced,
// observable pipeline stage rather than an invisible route-level check.
//
// A thin adapter: the screening logic itself stays in src/lib/chat/screen.ts,
// the single tested implementation. At START, `state.query` IS the raw user
// message — resolve_query has not rewritten it yet — so this node sees exactly
// what the user typed, which is the text a screen must judge.
//
// `state.history` is screened too. The route's own turns were screened at write
// time, but the graph is a second ingestion point (tests, future callers) that
// can be invoked with turns the route never saw — the exact caller the unused
// `history` parameter of screenChatInput was kept for.
//
// On a block the router (routeAfterGuardrail in graph.ts) short-circuits the
// run straight to persist_trace: no LLM calls, no retrieval, no memory write,
// no logged answer — but a recorded agent_runs row with finalStatus "blocked",
// which is the entire point of moving the screen into the graph.
import { screenChatInput } from "../../chat/screen";
import type { AgentStateType } from "../state";

export async function inputGuardrailNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  return { guardrail: screenChatInput(state.query, state.history) };
}
