// Log node (SRS logging): reuses logRecommendation to write the turn to
// ai_recommendations. The agent answer is sectioned JSON, so finalAnswer stores
// the serialized sections; sourcesUsed is read straight from the Career Data
// envelope — the agencies + resource docs that backed the answer PLUS the external
// (Tavily) sourced results, which now ground the free text and pass verification.
// The envelope is the single source of truth for what grounded the answer, so the
// persisted ai_recommendations.sources_used no longer omits the external sources.
// Falls back to [] if the envelope is absent (a short-circuited run). Never blocks
// the response; skipped when state.persist is false.
//
// `query` PERSISTS THE RAW USER MESSAGE (`originalQuery`), not the resolved one.
// Two reasons. First, consistency: the route's failure path already writes the raw
// message (api/agent-chat/route.ts), so recording the rewrite here made successful
// and failed runs disagree about what "query" means in the same column. Second,
// this table is the evaluation and support corpus — "what did the user ask?" must
// be answerable from it, and a machine rewrite cannot answer that.
//
// The resolved query is NOT lost: persist_trace writes it to agent_runs.query, and
// agent_runs.recommendation_id foreign-keys to the row written here. So the two
// forms stay joinable, one per table, with no schema change needed:
//   ai_recommendations.query -> what the user typed
//   agent_runs.query         -> what retrieval actually ran on
import { logRecommendation } from "../../chat/queries";
import type { AgentStateType } from "../state";

export async function logNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  if (!state.persist) return {};
  try {
    const sourcesUsed = state.careerData?.sourcesUsed ?? [];

    const row = await logRecommendation({
      userId: state.userId,
      // Fallback for a direct/partial graph invocation where resolve_query never ran.
      query: state.originalQuery || state.query,
      finalAnswer: JSON.stringify(state.sections ?? {}),
      intent: state.intent,
      sourcesUsed: sourcesUsed.length > 0 ? sourcesUsed : undefined,
      evaluationScore: state.evaluation,
    });
    // Surfaced so the trace row can foreign-key to this recommendation.
    return { recommendationId: row?.id };
  } catch (error) {
    console.error("Agent ai_recommendations logging failed:", error);
  }
  return {};
}
