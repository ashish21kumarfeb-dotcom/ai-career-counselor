import { db } from "../../db";
import { aiRecommendations } from "../../db/schema";

// Data-access helper for logging a chat turn to `ai_recommendations`. `intent`,
// `sourcesUsed`, and `evaluationScore` are optional and omitted -> null. The
// The agentic chat passes evaluationScore (SRS §8); callers may omit it (null).
export async function logRecommendation(input: {
  userId: string;
  query: string;
  finalAnswer: string;
  intent?: string;
  sourcesUsed?: Array<{ id: string; type: string; sourceUrl: string | null }>;
  evaluationScore?: unknown;
}) {
  const rows = await db
    .insert(aiRecommendations)
    .values({
      userId: input.userId,
      query: input.query,
      finalAnswer: input.finalAnswer,
      intent: input.intent,
      sourcesUsed: input.sourcesUsed,
      evaluationScore: input.evaluationScore,
    })
    .returning({ id: aiRecommendations.id });

  return rows[0];
}
