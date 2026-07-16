// Persistence tests for the agentic-chat POC step (e): the memory + log nodes.
// Uses a real throwaway user (FK-safe), drives the nodes directly, asserts rows
// are written to memory / ai_recommendations, and that persist:false writes
// nothing. The memory part needs GROQ (extractMemories); the log part does not.
// Run: npm run test:persist   (requires DATABASE_URL; memory part needs GROQ_API_KEY)
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index";
import { users, memory, aiRecommendations } from "../src/db/schema";
import { memoryNode } from "../src/lib/agent/nodes/memory";
import { logNode } from "../src/lib/agent/nodes/log";
import type { AgentStateType } from "../src/lib/agent/state";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`);
  }
}

const email = "persisttest+verify@example.test";

function makeState(over: Partial<AgentStateType>): AgentStateType {
  return {
    userId: "",
    query: "",
    runId: "",
    trace: [],
    recommendationId: undefined,
    memoryUpdate: undefined,
    persist: true,
    intent: "other",
    profile: undefined,
    memory: [],
    ragDocs: [],
    plan: undefined,
    executionPlan: undefined,
    toolResults: { agencies: [], resources: [] },
    sections: undefined,
    verification: undefined,
    evaluation: undefined,
    profileAgent: undefined,
    careerData: undefined,
    recommendation: undefined,
    verificationResult: undefined,
    regenerationAttempts: 0,
    ...over,
  };
}

await db.delete(users).where(eq(users.email, email));
const [u] = await db.insert(users).values({ name: "Persist Test", email }).returning({ id: users.id });
const userId = u.id;

try {
  // ===== log node =====
  console.log("\n== log node ==");
  const logState = makeState({
    userId,
    query: "How do I become a data analyst?",
    intent: "career_advice",
    sections: { ai_suggestion: "Focus on SQL and Python." },
    toolResults: {
      agencies: [{ id: "ag1", name: "X", location: "Delhi", services: "counselling", website: null, sourceUrl: "internal-seed/x" }],
      resources: [{ id: "doc1", type: "career_data", content: "Roadmap", sourceUrl: "https://roadmap.sh/data-analyst" }],
    },
    evaluation: { groundedness: 8, relevance: 9, personalization: 6, actionability: 8, safety: 10, hallucination_risk: "low", notes: "ok", overall: 8.2 },
  });

  await logNode({ ...logState, persist: false });
  let rows = await db.select().from(aiRecommendations).where(eq(aiRecommendations.userId, userId));
  check("persist:false writes no ai_recommendations row", rows.length === 0, `count=${rows.length}`);

  await logNode(logState);
  rows = await db.select().from(aiRecommendations).where(eq(aiRecommendations.userId, userId));
  check("persist:true writes exactly one row", rows.length === 1, `count=${rows.length}`);
  check("row stores the query", rows[0]?.query === "How do I become a data analyst?");
  check("row stores the intent", rows[0]?.intent === "career_advice");
  check("row stores 2 sources (agency + resource)", Array.isArray(rows[0]?.sourcesUsed) && (rows[0]?.sourcesUsed as unknown[]).length === 2, JSON.stringify(rows[0]?.sourcesUsed));
  check("finalAnswer is the serialized sections", typeof rows[0]?.finalAnswer === "string" && rows[0]!.finalAnswer!.includes("ai_suggestion"));
  check("row stores evaluation_score (SRS §8)", !!rows[0]?.evaluationScore && (rows[0]!.evaluationScore as { overall?: number }).overall === 8.2, JSON.stringify(rows[0]?.evaluationScore));

  // ===== memory node =====
  console.log("\n== memory node ==");
  if (!process.env.GROQ_API_KEY) {
    console.log("  (skipped: no GROQ_API_KEY)");
  } else {
    const memState = makeState({ userId, query: "I want fully remote roles." });

    await memoryNode({ ...memState, persist: false });
    let mrows = await db.select().from(memory).where(eq(memory.userId, userId));
    check("persist:false writes no memory row", mrows.length === 0, `count=${mrows.length}`);

    await memoryNode(memState);
    mrows = await db.select().from(memory).where(eq(memory.userId, userId));
    check("persist:true writes a memory row", mrows.length >= 1, `count=${mrows.length}`);
    check("stored key is in the fixed vocabulary", mrows.every((r) => ["target_role_or_company", "work_preferences", "constraints", "timeline", "actions_taken"].includes(r.memoryKey)), JSON.stringify(mrows.map((r) => r.memoryKey)));
  }
} finally {
  await db.delete(aiRecommendations).where(eq(aiRecommendations.userId, userId));
  await db.delete(memory).where(eq(memory.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  console.log("\ncleaned up throwaway user + rows.");
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
