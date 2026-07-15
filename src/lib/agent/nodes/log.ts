// Log node (SRS logging): reuses logRecommendation to write the turn to
// ai_recommendations. The agent answer is sectioned JSON, so finalAnswer stores
// the serialized sections; sourcesUsed combines the agencies and resource docs
// that actually backed the answer. Never blocks the response; skipped when
// state.persist is false.
import { logRecommendation } from "../../chat/queries";
import type { AgentStateType } from "../state";

export async function logNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  if (!state.persist) return {};
  try {
    const sourcesUsed = [
      ...state.toolResults.agencies.map((a) => ({
        id: a.id,
        type: "agency",
        sourceUrl: a.sourceUrl,
      })),
      ...state.toolResults.resources.map((d) => ({
        id: d.id,
        type: d.type,
        sourceUrl: d.sourceUrl,
      })),
    ];

    const row = await logRecommendation({
      userId: state.userId,
      query: state.query,
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
