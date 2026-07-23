// Verification -> Planner re-planning loop. When verification rejects a draft
// because the EVIDENCE was insufficient (needsMoreContext), the run goes back to
// the planner for a full re-plan + re-retrieval pass instead of regenerating
// against the same thin evidence. Bounded by AGENT_MAX_REPLANS, independent of
// the regeneration budget.
// Run: npm run test:replan
import "dotenv/config";
import { deriveFinalStatus } from "../src/lib/agent/nodes/persistTrace";
import { verificationAgentOutputSchema } from "../src/lib/agent/agents/contracts";
import { buildRecommendedFix } from "../src/lib/agent/agents/verification";
import type { AgentStateType } from "../src/lib/agent/state";
import type { VerificationAgentOutput } from "../src/lib/agent/agents/contracts";

// Pin both budgets BEFORE the graph/config load (see agent-regeneration.test.mts
// for the pattern): 1 replan + 1 regeneration keeps the integration cheap while
// exercising both branches.
process.env.AGENT_MAX_REGENERATIONS ??= "1";
process.env.AGENT_MAX_REPLANS ??= "1";
const { routeAfterVerification, buildAgentGraph, MAX_REGENERATIONS } = await import("../src/lib/agent/graph");
const { readAgentConfig, agentConfig } = await import("../src/lib/agent/config");

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`); }
}

function verdict(over: Partial<VerificationAgentOutput> = {}): VerificationAgentOutput {
  return {
    approved: true, grounded: true, safe: true, softCheckAvailable: true,
    issues: [], verificationNotes: "ok", finalSections: {},
    ...over,
  };
}

function makeState(over: Partial<AgentStateType>): AgentStateType {
  return {
    userId: "00000000-0000-0000-0000-000000000000",
    query: "how do I become a data analyst?",
    history: [], conversationId: "", originalQuery: "",
    runId: "", trace: [], recommendationId: undefined, memoryUpdate: undefined, persist: false,
    guardrail: undefined,
    intent: "career_advice", profile: undefined, memory: [], ragDocs: [],
    plan: { sections: ["ai_suggestion", "roadmap"], reasoning: "test" },
    executionPlan: undefined,
    toolResults: { agencies: [], resources: [] },
    sections: undefined, verification: undefined, evaluation: undefined,
    profileAgent: undefined, careerData: undefined, recommendation: undefined,
    verificationResult: undefined, regenerationAttempts: 0,
    intentSlots: undefined,
    replanAttempts: 0, plannerFeedback: undefined,
    ...over,
  };
}

const rejectedThin = () =>
  verdict({ approved: false, issues: ["not grounded"], needsMoreContext: true, missingContextHints: ["salary data for Berlin"] });
const rejectedPlain = () => verdict({ approved: false, issues: ["not grounded"] });

console.log("\n== router: replan only on the explicit signal, checked before regenerate ==");
{
  check("rejected + needsMoreContext, budget left -> replan", routeAfterVerification(makeState({ verificationResult: rejectedThin() })) === "replan");
  check("rejected + needsMoreContext, budget spent -> falls through to regenerate", routeAfterVerification(makeState({ verificationResult: rejectedThin(), replanAttempts: agentConfig.maxReplans })) === "regenerate");
  check("rejected WITHOUT the signal -> regenerate (today's behavior)", routeAfterVerification(makeState({ verificationResult: rejectedPlain() })) === "regenerate");
  check("approved never replans", routeAfterVerification(makeState({ verificationResult: verdict({ approved: true, needsMoreContext: true }) })) === "proceed");
  check("no verdict -> fallback, never replan", routeAfterVerification(makeState({ verificationResult: undefined, replanAttempts: 0 })) === "fallback");
  check("both budgets spent -> fallback", routeAfterVerification(makeState({ verificationResult: rejectedThin(), replanAttempts: agentConfig.maxReplans, regenerationAttempts: MAX_REGENERATIONS })) === "fallback");
}
{
  // Termination sweep: no (regenerationAttempts, replanAttempts) pair may loop
  // forever — every rejected state must eventually reach fallback because both
  // counters only ever increase and each non-fallback route increments one.
  let nonTerminal = 0;
  for (let regen = 0; regen <= MAX_REGENERATIONS + 3; regen++) {
    for (let replan = 0; replan <= agentConfig.maxReplans + 3; replan++) {
      const route = routeAfterVerification(makeState({ verificationResult: rejectedThin(), regenerationAttempts: regen, replanAttempts: replan }));
      if (regen >= MAX_REGENERATIONS && replan >= agentConfig.maxReplans && route !== "fallback") nonTerminal++;
    }
  }
  check("every exhausted-budget state routes to fallback", nonTerminal === 0, `nonTerminal=${nonTerminal}`);
  check("AGENT_MAX_REPLANS=0 restores regenerate-only routing", readAgentConfig({ AGENT_MAX_REPLANS: "0" }).maxReplans === 0);
}

console.log("\n== finalStatus: 'replanned' reported, and it wins over 'regenerated' ==");
{
  check("approved after a replan -> replanned", deriveFinalStatus(makeState({ verificationResult: verdict({ approved: true }), replanAttempts: 1 })) === "replanned");
  check("replanned wins over regenerated", deriveFinalStatus(makeState({ verificationResult: verdict({ approved: true }), replanAttempts: 1, regenerationAttempts: 1 })) === "replanned");
  check("approved without a replan -> unchanged (approved)", deriveFinalStatus(makeState({ verificationResult: verdict({ approved: true }) })) === "approved");
  check("rejected after a replan -> still fallback", deriveFinalStatus(makeState({ verificationResult: verdict({ approved: false }), replanAttempts: 1 })) === "fallback");
}

console.log("\n== contract: the new fields are optional ==");
{
  check("verdict WITHOUT the new fields validates", verificationAgentOutputSchema.safeParse(rejectedPlain()).success);
  check("verdict WITH the new fields validates", verificationAgentOutputSchema.safeParse(rejectedThin()).success);
  const bad = verificationAgentOutputSchema.safeParse({ ...verdict(), needsMoreContext: "yes" });
  check("malformed needsMoreContext is rejected", !bad.success);
}

// ---------------------------------------------------------------------------
// Integration: the REAL graph, verification stubbed (the same injection pattern
// as agent-regeneration.test.mts). First verdict rejects with needsMoreContext;
// the second (post-replan) approves. Retrieval MUST re-run — that is the point
// of the replan edge — and the fresh pass must NOT count as a regeneration.
if (!process.env.GROQ_API_KEY) {
  console.log("\n== integration: replan loop == (skipped: no GROQ_API_KEY)");
} else {
  console.log("\n== integration: rejected for thin evidence -> replan -> approved ==");
  let calls = 0;
  const graph = buildAgentGraph({
    verificationNode: async (s) => {
      calls++;
      const draft = s.recommendation?.draftSections ?? {};
      if (calls === 1) {
        return {
          verificationResult: verdict({
            approved: false,
            issues: ["stubbed: evidence insufficient"],
            needsMoreContext: true,
            missingContextHints: ["stubbed missing evidence"],
            recommendedFix: buildRecommendedFix(["stubbed"]),
            finalSections: draft,
          }),
          verification: { grounded: false, safe: true, notes: "stubbed thin evidence" },
          sections: draft,
        };
      }
      return {
        verificationResult: verdict({ approved: true, finalSections: draft }),
        verification: { grounded: true, safe: true, notes: "stubbed approval" },
        sections: draft,
      };
    },
  });
  const r = await graph.invoke({ userId: "00000000-0000-0000-0000-000000000000", query: "How do I become a data analyst?", persist: false });
  const steps = (r.trace ?? []).map((e) => e.step);
  const countOf = (s: string) => steps.filter((x) => x === s).length;

  check("verification ran twice (loop closed)", calls === 2, `calls=${calls}`);
  check("planner ran twice (re-planned)", countOf("planner") === 2, JSON.stringify(steps));
  check("retrieval RE-RUN (unlike regenerate)", countOf("career_data_agent") === 2, JSON.stringify(steps));
  check("recommendation ran twice (fresh draft per plan)", countOf("recommendation_agent") === 2, JSON.stringify(steps));
  check("replanAttempts reached exactly 1", r.replanAttempts === 1, String(r.replanAttempts));
  // THE stale-verdict fix: the re-planned pass is a first draft against a new
  // plan, not a regeneration. Without plannerNode clearing verificationResult,
  // this would be 1.
  check("regenerationAttempts stayed 0 (stale verdict cleared)", r.regenerationAttempts === 0, String(r.regenerationAttempts));
  check("no safe_fallback (the replan was accepted)", countOf("safe_fallback") === 0);
  check("run terminated (reached log_turn)", countOf("log_turn") === 1);
  check("finalStatus derives to 'replanned'", deriveFinalStatus(r as AgentStateType) === "replanned");
  check("replan is legible in the trace", (r.trace ?? []).some((e) => e.step === "planner" && e.type === "regeneration"), JSON.stringify((r.trace ?? []).map((e) => `${e.step}:${e.type}`)));
  check("planner feedback carried the hints", (r.plannerFeedback?.missingContext ?? []).includes("stubbed missing evidence"), JSON.stringify(r.plannerFeedback));
  check("trace seq stays dense across the loop", (r.trace ?? []).every((e, i) => e.seq === i), JSON.stringify((r.trace ?? []).map((e) => e.seq)));
  console.log("  --- trace ---");
  for (const e of r.trace ?? []) console.log(`  ${String(e.seq).padStart(2)}. [${e.status.padEnd(8)}] ${e.step.padEnd(20)} ${e.summary}`);
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
