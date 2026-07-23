// Query-provenance regression tests.
//
// THE INVARIANT UNDER TEST — two channels, two audiences, and they must not be
// swapped back:
//
//   state.query         (the resolved standalone form) -> anything that ACTS ON
//                       the question: gates, retrieval, generation, the trace row.
//   state.originalQuery (the raw user message)         -> anything that RECORDS or
//                       DERIVES DURABLE STATE: memory extraction, ai_recommendations.
//
// The scenario is the one that motivated the rule: a conversation about cyber
// security, then the elliptical follow-up "What about salary?". Resolving it is
// what makes retrieval work at all; storing the resolution is what corrupts the
// record. Memory is the sharpest case — it is the one write that outlives the
// run, and isGrounded() validates each extracted fact against the text it was
// extracted FROM, so extracting from the rewrite makes the guard self-confirming
// and launders a rewriter hallucination into permanent user state.
//
// Parts B-E deliberately do NOT depend on the live rewrite: they drive the nodes
// with a FIXED resolved-form fixture, so the regression assertions are
// deterministic. Part A is the only part that asks the model to actually rewrite.
//
// Run: npm run test:provenance
//   (requires DATABASE_URL; parts A and E additionally need GROQ_API_KEY)
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index";
import { users, memory, documents, aiRecommendations, agentRuns } from "../src/db/schema";
import { resolveQueryNode } from "../src/lib/agent/nodes/resolveQuery";
import { careerDataAgentNode } from "../src/lib/agent/nodes/careerDataAgent";
import { memoryNode } from "../src/lib/agent/nodes/memory";
import { logNode } from "../src/lib/agent/nodes/log";
import { persistTraceNode } from "../src/lib/agent/nodes/persistTrace";
import { getRunByRunId } from "../src/lib/agent/trace/queries";
import { searchDocuments } from "../src/lib/documents/queries";
import { createDocument } from "../src/lib/documents/write";
import { isGrounded } from "../src/lib/ai/memory";
import { hasReferentialMarker, isTopicShift } from "../src/lib/ai/resolveQuery";
import type { ChatTurn } from "../src/lib/ai/resolveQuery";
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

// --- The scenario -----------------------------------------------------------
const HISTORY: ChatTurn[] = [
  { role: "user", content: "Tell me about Cyber Security." },
  {
    role: "assistant",
    content:
      "Cyber security roles include SOC analyst, penetration tester and security engineer. Skills to focus on: networking, Linux and SIEM tools.",
  },
];

// The raw follow-up. Meaningless on its own — that is the point.
const RAW = "What about salary?";

// The resolved standalone form. A FIXTURE, not the live rewrite: parts B-E assert
// on node behaviour, and they must fail for a provenance regression, never for a
// model that phrased the rewrite differently today.
const RESOLVED = "What is the average salary for a Cyber Security engineer?";

const email = "provenancetest+verify@example.test";

await db.delete(users).where(eq(users.email, email));
const [u] = await db
  .insert(users)
  .values({ name: "Provenance Test", email })
  .returning({ id: users.id });
const userId = u.id;

// A user-owned document the RESOLVED query retrieves and the RAW one cannot.
// Owned rather than global so the fixture is self-contained and cleaned up.
// Seeded via createDocument so the fixture also gets its document_chunks rows —
// retrieval matches on chunks, so a raw insert is invisible to searchDocuments.
const docId = await createDocument({
  userId,
  type: "career_data",
  content:
    "Cyber security engineer career note: a cyber security engineer secures networks, runs SIEM tooling and handles incident response.",
});

function makeState(over: Partial<AgentStateType>): AgentStateType {
  return {
    userId: "",
    query: "",
    history: [],
    conversationId: "",
    originalQuery: "",
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
    guardrail: undefined,
    intentSlots: undefined,
    replanAttempts: 0,
    plannerFeedback: undefined,
    ...over,
  };
}

try {
  // =========================================================================
  console.log("\n== A. resolve_query rewrites the follow-up ==");
  // Preconditions, LLM-free: the follow-up must reach the resolver rather than
  // being short-circuited by a skip gate. If either of these flips, the rest of
  // the scenario is vacuous and would silently stop testing anything.
  check("'What about salary?' carries a referential marker", hasReferentialMarker(RAW));
  check("it is not classed a topic shift away from cyber security", !isTopicShift(RAW, HISTORY));

  if (!process.env.GROQ_API_KEY) {
    console.log("  (live rewrite skipped: no GROQ_API_KEY)");
  } else {
    const out = await resolveQueryNode(makeState({ userId, query: RAW, history: HISTORY }));
    console.log(`  resolved: ${JSON.stringify(out.query)}`);
    check("originalQuery preserves the raw message verbatim", out.originalQuery === RAW, String(out.originalQuery));
    check("query is rewritten (no longer the raw message)", out.query !== RAW, String(out.query));
    check(
      "the rewrite carries the subject forward from history",
      /cyber|security/i.test(out.query ?? ""),
      String(out.query)
    );
  }

  // =========================================================================
  console.log("\n== B. retrieval acts on the RESOLVED query ==");
  // The discriminator is structural, not corpus-dependent: "salary" is a GENERIC
  // term in documents/queries.ts, so the raw follow-up carries no specific topic
  // term and retrieval returns [] by construction.
  const rawDocs = await searchDocuments(RAW, userId);
  check("raw follow-up retrieves nothing (no specific topic term)", rawDocs.length === 0, JSON.stringify(rawDocs.map((d) => d.id)));

  const resolvedDocs = await searchDocuments(RESOLVED, userId);
  check("resolved query retrieves the seeded cyber-security doc", resolvedDocs.some((d) => d.id === docId), JSON.stringify(resolvedDocs.map((d) => d.id)));

  // The node itself: it must read state.query. Reading originalQuery would give
  // it "What about salary?" and ragDocs would come back empty.
  const cdOut = await careerDataAgentNode(
    makeState({ userId, query: RESOLVED, originalQuery: RAW, intent: "career_advice", persist: false })
  );
  check(
    "careerDataAgentNode grounds on the resolved query, not originalQuery",
    (cdOut.ragDocs ?? []).some((d) => d.id === docId),
    JSON.stringify((cdOut.ragDocs ?? []).map((d) => d.id))
  );

  // =========================================================================
  console.log("\n== C. ai_recommendations.query stores the RAW message ==");
  const logState = makeState({
    userId,
    query: RESOLVED,
    originalQuery: RAW,
    intent: "career_advice",
    sections: { ai_suggestion: "Cyber security salaries vary by role and experience." },
  });

  const logOut = await logNode(logState);
  const recId = logOut.recommendationId;
  check("log node returned a recommendation id", typeof recId === "string" && recId.length > 0, String(recId));

  const recRows = await db.select().from(aiRecommendations).where(eq(aiRecommendations.userId, userId));
  check("exactly one ai_recommendations row", recRows.length === 1, `count=${recRows.length}`);
  check("row.query === originalQuery (what the user typed)", recRows[0]?.query === RAW, String(recRows[0]?.query));
  check("row.query is NOT the resolved rewrite", recRows[0]?.query !== RESOLVED, String(recRows[0]?.query));

  // The documented fallback: on a direct/partial invocation resolve_query never
  // ran, originalQuery is "", and the node must fall back to query rather than
  // writing an empty string into a NOT NULL column.
  await logNode(makeState({ userId, query: RESOLVED, originalQuery: "", intent: "career_advice" }));
  const fallbackRows = await db.select().from(aiRecommendations).where(eq(aiRecommendations.userId, userId));
  const fallback = fallbackRows.find((r) => r.id !== recId);
  check("empty originalQuery falls back to query", fallback?.query === RESOLVED, String(fallback?.query));

  // =========================================================================
  console.log("\n== D. agent_runs.query stores the RESOLVED query ==");
  const runId = randomUUID();
  await persistTraceNode(
    makeState({ userId, runId, query: RESOLVED, originalQuery: RAW, intent: "career_advice", recommendationId: recId })
  );

  const run = await getRunByRunId(runId);
  check("agent_runs row was written", !!run, "no row");
  check("run.query === the resolved query (what retrieval ran on)", run?.query === RESOLVED, String(run?.query));
  check("run.query is NOT the raw follow-up", run?.query !== RAW, String(run?.query));

  // The claim that made a schema migration unnecessary: both forms survive, one
  // per table, joined by agent_runs.recommendation_id.
  check("run foreign-keys to the recommendation", run?.recommendationId === recId, String(run?.recommendationId));
  const joined = recRows.find((r) => r.id === run?.recommendationId);
  check(
    "the join yields both forms: raw on the recommendation, resolved on the run",
    joined?.query === RAW && run?.query === RESOLVED,
    `${joined?.query} | ${run?.query}`
  );

  // =========================================================================
  console.log("\n== E. memory extraction reads the RAW message ==");
  // The discriminator relies on isGrounded: a fact stated ONLY in the raw message
  // cannot be extracted from the rewrite, because the grounding guard would
  // reject it for lack of support in the text it was extracted from.
  const RAW_WITH_PREF = "What about salary? I only want fully remote roles.";
  check(
    "the remote preference is ungrounded in the resolved query (so this test can discriminate)",
    !isGrounded("User only wants fully remote roles.", RESOLVED)
  );
  check(
    "the remote preference IS grounded in the raw message",
    isGrounded("User only wants fully remote roles.", RAW_WITH_PREF)
  );

  if (!process.env.GROQ_API_KEY) {
    console.log("  (extraction skipped: no GROQ_API_KEY)");
  } else {
    const memOut = await memoryNode(
      makeState({ userId, query: RESOLVED, originalQuery: RAW_WITH_PREF })
    );
    const mrows = await db.select().from(memory).where(eq(memory.userId, userId));
    console.log(`  memoryUpdate: ${JSON.stringify(memOut.memoryUpdate)}`);
    console.log(`  stored: ${JSON.stringify(mrows.map((r) => `${r.memoryKey}=${r.memoryValue}`))}`);

    check("memory node reports ok", memOut.memoryUpdate?.status === "ok", JSON.stringify(memOut.memoryUpdate));
    check(
      "a fact stated ONLY in the raw message was stored",
      mrows.some((r) => /remote/i.test(r.memoryValue)),
      JSON.stringify(mrows.map((r) => r.memoryValue))
    );
    check(
      "the rewrite's subject did NOT leak into permanent memory",
      !mrows.some((r) => /cyber|security/i.test(r.memoryValue)),
      JSON.stringify(mrows.map((r) => r.memoryValue))
    );
  }
} finally {
  await db.delete(agentRuns).where(eq(agentRuns.userId, userId));
  await db.delete(aiRecommendations).where(eq(aiRecommendations.userId, userId));
  await db.delete(memory).where(eq(memory.userId, userId));
  await db.delete(documents).where(eq(documents.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  console.log("\ncleaned up throwaway user + rows.");
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
