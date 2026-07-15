// Verification -> Recommendation regeneration loop. Fully deterministic: the
// router is a pure function, and the node-level loop is driven by hand with
// stubbed verdicts so no LLM or DB is touched.
// Run: npm run test:regen
import "dotenv/config";
import { routeAfterVerification, MAX_REGENERATIONS } from "../src/lib/agent/graph";
import { deriveFinalStatus } from "../src/lib/agent/nodes/persistTrace";
import { safeFallbackNode } from "../src/lib/agent/nodes/safeFallback";
import { buildRecommendedFix, SAFE_FALLBACK_TEXT } from "../src/lib/agent/agents/verification";
import { verificationAgentOutputSchema } from "../src/lib/agent/agents/contracts";
import type { AgentStateType } from "../src/lib/agent/state";
import type { VerificationAgentOutput } from "../src/lib/agent/agents/contracts";
import type { ResponseSections } from "../src/lib/agent/schema";

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
    runId: "", trace: [], recommendationId: undefined, memoryUpdate: undefined, persist: false,
    intent: "career_advice", profile: undefined, memory: [], ragDocs: [],
    plan: { sections: ["ai_suggestion", "roadmap"], reasoning: "test" },
    executionPlan: undefined,
    toolResults: { agencies: [], resources: [] },
    sections: undefined, verification: undefined, evaluation: undefined,
    profileAgent: undefined, careerData: undefined, recommendation: undefined,
    verificationResult: undefined, regenerationAttempts: 0,
    ...over,
  };
}

console.log("\n== router: exactly one retry, and it terminates ==");
{
  check("approved -> proceed", routeAfterVerification(makeState({ verificationResult: verdict({ approved: true }) })) === "proceed");
  check("rejected, no retry yet -> regenerate", routeAfterVerification(makeState({ verificationResult: verdict({ approved: false }), regenerationAttempts: 0 })) === "regenerate");
  check("rejected, already retried -> fallback", routeAfterVerification(makeState({ verificationResult: verdict({ approved: false }), regenerationAttempts: 1 })) === "fallback");
  check("approved AFTER a retry -> proceed", routeAfterVerification(makeState({ verificationResult: verdict({ approved: true }), regenerationAttempts: 1 })) === "proceed");
  // No verdict at all: verification itself broke. Regenerating would be guesswork.
  check("no verdict -> fallback (never loops on a missing verdict)", routeAfterVerification(makeState({ verificationResult: undefined })) === "fallback");
  check("MAX_REGENERATIONS is 1 (spec: regenerate once)", MAX_REGENERATIONS === 1);
}
{
  // Termination: whatever the attempt count, a rejected run must eventually stop.
  let loops = 0;
  for (let attempts = 0; attempts <= 5; attempts++) {
    if (routeAfterVerification(makeState({ verificationResult: verdict({ approved: false }), regenerationAttempts: attempts })) === "regenerate") loops++;
  }
  check("only ONE attempt count can route to regenerate", loops === 1, `loops=${loops}`);
}

console.log("\n== finalStatus reports the ending honestly ==");
{
  check("first-pass approval -> approved", deriveFinalStatus(makeState({ verificationResult: verdict({ approved: true }), regenerationAttempts: 0 })) === "approved");
  check("approval after a retry -> regenerated (not 'approved')", deriveFinalStatus(makeState({ verificationResult: verdict({ approved: true }), regenerationAttempts: 1 })) === "regenerated");
  check("still rejected -> fallback", deriveFinalStatus(makeState({ verificationResult: verdict({ approved: false }), regenerationAttempts: 1 })) === "fallback");
  check("no verdict -> failed", deriveFinalStatus(makeState({ verificationResult: undefined })) === "failed");
  // Phase 1's ending is gone now that rejection is no longer terminal.
  const statuses = [
    deriveFinalStatus(makeState({ verificationResult: verdict({ approved: true }) })),
    deriveFinalStatus(makeState({ verificationResult: verdict({ approved: false }), regenerationAttempts: 1 })),
  ];
  check("'corrected' is no longer produced", !statuses.includes("corrected" as never), JSON.stringify(statuses));
}

console.log("\n== feedback: verification tells recommendation what to fix ==");
{
  check("no fix offered when there is nothing to fix", buildRecommendedFix([]) === undefined);
  const fix = buildRecommendedFix(["Removed 1 agency item(s) not backed by verified records."])!;
  check("a rejected draft gets a correction brief", typeof fix === "string" && fix.length > 0);
  check("brief forbids inventing providers", /do not invent/i.test(fix), fix);
  check("brief restricts to supplied context", /only the agencies, courses and links supplied/i.test(fix), fix);
}
{
  // recommendedFix is the previously-unused contract field; it must be populated
  // on rejection and absent on approval, since its presence is the signal.
  const parsedReject = verificationAgentOutputSchema.safeParse(verdict({ approved: false, issues: ["x"], recommendedFix: buildRecommendedFix(["x"]) }));
  check("rejected verdict validates against the runtime contract", parsedReject.success, JSON.stringify(parsedReject.error?.issues));
  const parsedOk = verificationAgentOutputSchema.safeParse(verdict({ approved: true }));
  check("approved verdict validates with no recommendedFix", parsedOk.success);
  const bad = verificationAgentOutputSchema.safeParse({ ...verdict(), approved: "yes" });
  check("runtime contract rejects a malformed verdict", !bad.success);
}

console.log("\n== safe fallback: safe, but keeps verified data ==");
{
  const sanitized: ResponseSections = {
    ai_suggestion: "Guaranteed job in 30 days!",
    roadmap: { items: ["step"], suggested: true },
    skill_focus: ["SQL"],
    next_steps: ["apply"],
    agencies: { items: [{ name: "Acme Careers", location: "Delhi", services: "counselling", website: "https://acme", source: "src" }] },
    resources: { items: [{ title: "Roadmap", type: "career_data", url: "https://res/roadmap" }] },
  };
  const out = await safeFallbackNode(makeState({
    plan: { sections: ["ai_suggestion", "roadmap", "agencies", "resources"], reasoning: "t" },
    verificationResult: verdict({ approved: false, finalSections: sanitized }),
  }));
  const s = out.sections!;
  check("free text replaced with the safe summary", s.ai_suggestion === SAFE_FALLBACK_TEXT);
  check("roadmap dropped", s.roadmap === undefined);
  check("skill_focus dropped", s.skill_focus === undefined);
  check("next_steps dropped", s.next_steps === undefined);
  // These were never LLM-authored, so a free-text failure is no reason to lose them.
  check("verified agencies KEPT", s.agencies?.items[0]?.name === "Acme Careers");
  check("verified resources KEPT", s.resources?.items[0]?.url === "https://res/roadmap");
}
{
  // The fallback must build on the SANITIZED sections, never the raw draft.
  const out = await safeFallbackNode(makeState({
    plan: { sections: ["ai_suggestion"], reasoning: "t" },
    sections: { ai_suggestion: "RAW UNSANITIZED DRAFT" },
    verificationResult: verdict({ approved: false, finalSections: { ai_suggestion: "sanitized" } }),
  }));
  check("starts from sanitized sections, not the raw draft", out.sections?.ai_suggestion === SAFE_FALLBACK_TEXT);
}
{
  // ai_suggestion was never planned -> do not invent one.
  const out = await safeFallbackNode(makeState({
    plan: { sections: ["agencies"], reasoning: "t" },
    verificationResult: verdict({ approved: false, finalSections: { agencies: { items: [] , note: "none" } } }),
  }));
  check("no ai_suggestion when it was not planned", out.sections?.ai_suggestion === undefined);
  check("planned agencies section survives", out.sections?.agencies !== undefined);
}

// ---------------------------------------------------------------------------
// Integration: the REAL graph, with only the verdict stubbed. The unit tests
// above prove the router is correct; only this proves the graph is wired to it.
if (!process.env.GROQ_API_KEY) {
  console.log("\n== integration: live graph loop == (skipped: no GROQ_API_KEY)");
} else {
  const { buildAgentGraph } = await import("../src/lib/agent/graph");
  const { verificationAgentNode } = await import("../src/lib/agent/nodes/verificationAgent");
  const NOBODY = "00000000-0000-0000-0000-000000000000";
  const QUERY = "How do I become a data analyst?";

  console.log("\n== integration: rejected twice -> regenerate -> fallback ==");
  {
    let calls = 0;
    // Reject every time: forces regenerate, then fallback.
    const graph = buildAgentGraph({
      verificationNode: async (s) => {
        calls++;
        const draft = s.recommendation?.draftSections ?? {};
        return {
          verificationResult: verdict({ approved: false, issues: [`stubbed rejection #${calls}`], recommendedFix: buildRecommendedFix(["stubbed"]), finalSections: draft }),
          verification: { grounded: false, safe: false, notes: "stubbed" },
          sections: draft,
        };
      },
    });
    const r = await graph.invoke({ userId: NOBODY, query: QUERY, persist: false });
    const steps = (r.trace ?? []).map((e) => e.step);
    const countOf = (s: string) => steps.filter((x) => x === s).length;

    check("verification ran twice (loop closed)", calls === 2, `calls=${calls}`);
    check("recommendation ran twice", countOf("recommendation_agent") === 2, JSON.stringify(steps));
    check("regenerationAttempts reached exactly 1", r.regenerationAttempts === 1, String(r.regenerationAttempts));
    // The retry edge targets recommendation_agent, not career_data_agent.
    check("retrieval NOT re-run", countOf("career_data_agent") === 1, JSON.stringify(steps));
    check("planner NOT re-run", countOf("planner") === 1);
    check("safe_fallback ran", countOf("safe_fallback") === 1, JSON.stringify(steps));
    check("run terminated (reached log_turn)", countOf("log_turn") === 1);
    check("finalStatus derives to fallback", deriveFinalStatus(r as AgentStateType) === "fallback");
    check("free text is the safe summary", r.sections?.ai_suggestion === SAFE_FALLBACK_TEXT, JSON.stringify(r.sections?.ai_suggestion)?.slice(0, 70));

    const regenEvents = (r.trace ?? []).filter((e) => e.type === "regeneration");
    check("loop is legible in the trace (regeneration events)", regenEvents.length === 2, JSON.stringify(regenEvents.map((e) => e.step)));
    check("second recommendation re-typed as regeneration", (r.trace ?? []).some((e) => e.step === "recommendation_agent" && e.type === "regeneration"));
    check("trace seq stays dense across the loop", (r.trace ?? []).every((e, i) => e.seq === i), JSON.stringify((r.trace ?? []).map((e) => e.seq)));
    console.log("  --- trace ---");
    for (const e of r.trace ?? []) console.log(`  ${String(e.seq).padStart(2)}. [${e.status.padEnd(8)}] ${e.step.padEnd(20)} ${e.summary}`);
  }

  // These two blocks need the LLM to actually WRITE something. When Groq is
  // rate-limited, runRecommendationAgent swallows the failure and assembles DB
  // sections only, so every planned text section comes back empty — which
  // verification now (correctly) rejects, sending the run through the loop to a
  // safe fallback. That is the fix working, but it makes "approved first time"
  // unassertable. Detect it and assert the fail-closed contract instead, rather
  // than reporting an exhausted quota as a broken loop.
  function textGenerationWorked(trace: { step: string; status: string }[]): boolean {
    return trace.some((e) => e.step === "recommendation_agent" && e.status === "ok");
  }

  console.log("\n== integration: rejected once, then approved -> regenerated ==");
  {
    let calls = 0;
    const graph = buildAgentGraph({
      verificationNode: async (s) => {
        calls++;
        // Reject the first draft, accept the regenerated one.
        if (calls === 1) return { verificationResult: verdict({ approved: false, issues: ["stubbed rejection"], recommendedFix: buildRecommendedFix(["stubbed"]), finalSections: s.recommendation?.draftSections ?? {} }), sections: s.recommendation?.draftSections ?? {} };
        return verificationAgentNode(s); // real verifier on the retry
      },
    });
    const r = await graph.invoke({ userId: NOBODY, query: QUERY, persist: false });
    check("verification ran twice", calls === 2, `calls=${calls}`);
    check("regenerationAttempts is 1", r.regenerationAttempts === 1);
    if (!textGenerationWorked(r.trace ?? [])) {
      console.log("  NOTE: text generation unavailable (commonly a Groq rate limit). The retry");
      console.log("  produced an empty draft, which verification rejects by design, so the");
      console.log("  'retry accepted' expectations cannot be exercised. Asserting fail-closed.");
      check("degraded retry still terminates in a safe fallback", deriveFinalStatus(r as AgentStateType) === "fallback");
      check("degraded retry never ships an empty answer", r.sections?.ai_suggestion === SAFE_FALLBACK_TEXT);
    } else {
      check("no safe_fallback (the retry was accepted)", !(r.trace ?? []).some((e) => e.step === "safe_fallback"));
      check("finalStatus is 'regenerated', not 'approved'", deriveFinalStatus(r as AgentStateType) === "regenerated");
      check("answer is the regenerated draft, not the safe summary", r.sections?.ai_suggestion !== SAFE_FALLBACK_TEXT);
    }
  }

  console.log("\n== integration: approved first time -> no loop ==");
  {
    const graph = buildAgentGraph();
    const r = await graph.invoke({ userId: NOBODY, query: QUERY, persist: false });
    const steps = (r.trace ?? []).map((e) => e.step);
    if (!textGenerationWorked(r.trace ?? [])) {
      console.log("  NOTE: text generation unavailable (commonly a Groq rate limit), so there is");
      console.log("  no clean run to observe — an empty draft is rejected by design. Asserting");
      console.log("  that the degraded path still terminates safely instead.");
      check("degraded run loops at most once", steps.filter((s) => s === "recommendation_agent").length <= 2, JSON.stringify(steps));
      check("degraded run terminates", steps.includes("log_turn"));
      check("degraded run never ships an empty answer", r.sections?.ai_suggestion === SAFE_FALLBACK_TEXT);
    } else {
      check("recommendation ran once", steps.filter((s) => s === "recommendation_agent").length === 1, JSON.stringify(steps));
      check("regenerationAttempts stays 0", r.regenerationAttempts === 0);
      check("no safe_fallback on a clean run", !steps.includes("safe_fallback"));
      check("no regeneration events on a clean run", !(r.trace ?? []).some((e) => e.type === "regeneration"));
    }
  }
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
