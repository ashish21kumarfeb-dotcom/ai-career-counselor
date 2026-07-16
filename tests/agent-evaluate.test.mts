// Evaluate-node tests (SRS §8). Part A: deterministic schema coercion/validation.
// Part B: live evaluateNode + full-graph integration asserting a well-formed score
// (all metrics 0-10, valid risk level, overall = mean of the five).
// Run: npm run test:evaluate   (Part B requires GROQ_API_KEY + DATABASE_URL)
import "dotenv/config";
import { evaluationSchema } from "../src/lib/agent/schema";
import { evaluateNode } from "../src/lib/agent/nodes/evaluate";
import { agentGraph } from "../src/lib/agent/graph";
import type { AgentStateType } from "../src/lib/agent/state";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`); }
}

function makeState(over: Partial<AgentStateType>): AgentStateType {
  return {
    userId: "00000000-0000-0000-0000-000000000000",
    query: "",
    runId: "",
    trace: [],
    recommendationId: undefined,
    memoryUpdate: undefined,
    persist: false,
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

// ---------------------------------------------------------------------------
console.log("\n== A. Unit: evaluationSchema ==");
{
  const r = evaluationSchema.safeParse({ groundedness: "8", relevance: 9, personalization: "7", actionability: 8, safety: 10, hallucination_risk: "low", notes: "x" });
  check("coerces string numbers", r.success && r.data.groundedness === 8 && r.data.personalization === 7, JSON.stringify(r));
}
check("rejects out-of-range", !evaluationSchema.safeParse({ groundedness: 12, relevance: 9, personalization: 7, actionability: 8, safety: 10, hallucination_risk: "low", notes: "x" }).success);
check("rejects bad risk level", !evaluationSchema.safeParse({ groundedness: 8, relevance: 9, personalization: 7, actionability: 8, safety: 10, hallucination_risk: "unknown", notes: "x" }).success);

// ---------------------------------------------------------------------------
if (!process.env.GROQ_API_KEY) {
  console.log("\n== B. Live evaluate == (skipped: no GROQ_API_KEY)");
} else {
  console.log("\n== B. Live evaluateNode ==");
  const state = makeState({
    query: "How do I become a data analyst?",
    profile: undefined,
    ragDocs: [{ id: "d1", type: "career_data", content: "Data analytics starts with SQL and spreadsheets.", sourceUrl: "internal-seed/x" }],
    toolResults: {
      agencies: [],
      resources: [{ id: "r1", type: "career_data", content: "Data analyst roadmap: SQL, Python, BI.", sourceUrl: "https://roadmap.sh/data-analyst" }],
    },
    sections: {
      ai_suggestion: "Build SQL and spreadsheet skills first, then Python and a BI tool, and create portfolio projects.",
      roadmap: { items: ["Learn SQL", "Learn Python", "Build projects"], suggested: false },
      resources: { items: [{ title: "Data analyst roadmap", type: "career_data", url: "https://roadmap.sh/data-analyst" }] },
    },
  });

  const out = await evaluateNode(state);
  const e = out.evaluation;
  console.log("  ->", JSON.stringify(e));
  const nums = e ? [e.groundedness, e.relevance, e.personalization, e.actionability, e.safety] : [];
  check("evaluation is recorded", !!e);
  check("all five metrics are 0-10 numbers", nums.length === 5 && nums.every((n) => typeof n === "number" && n >= 0 && n <= 10), JSON.stringify(nums));
  check("hallucination_risk is a valid level", !!e && ["low", "medium", "high"].includes(e.hallucination_risk));
  check("overall = rounded mean of the five", !!e && Math.abs(e.overall - Math.round((nums.reduce((a, b) => a + b, 0) / 5) * 10) / 10) < 1e-9, JSON.stringify(e?.overall));

  console.log("\n== B. Full graph carries evaluation ==");
  const full = await agentGraph.invoke({ userId: "00000000-0000-0000-0000-000000000000", query: "I want to become a data analyst. Suggest a roadmap.", persist: false });
  check("graph result includes evaluation with overall", typeof full.evaluation?.overall === "number", JSON.stringify(full.evaluation));
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
