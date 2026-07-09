import { db } from "../../db";
import { aiRecommendations } from "../../db/schema";

// Data-access helper for logging a chat turn to `ai_recommendations`. Writes the
// columns available for the current slice; evaluation_score is left null for a
// later phase. `intent` and `sourcesUsed` are optional and omitted -> null.
export async function logRecommendation(input: {
  userId: string;
  query: string;
  finalAnswer: string;
  intent?: string;
  sourcesUsed?: Array<{ id: string; type: string; sourceUrl: string | null }>;
}) {
  const rows = await db
    .insert(aiRecommendations)
    .values({
      userId: input.userId,
      query: input.query,
      finalAnswer: input.finalAnswer,
      intent: input.intent,
      sourcesUsed: input.sourcesUsed,
    })
    .returning({ id: aiRecommendations.id });

  return rows[0];
}
