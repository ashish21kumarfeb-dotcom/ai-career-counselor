// Planner tests for the agentic-chat POC step (b). Two parts:
//   A) deterministic unit tests for the gates + finalizePlan (no LLM, no DB)
//   B) live graph runs (intent -> context -> planner) asserting the gate
//      INVARIANTS hold end-to-end (requires GROQ_API_KEY + DATABASE_URL)
// Run: npm run test:planner
import "dotenv/config";
import { agencyGate, resourceGate, finalizePlan, type PlannerNeeds } from "../src/lib/agent/schema";
import { fallbackNeeds } from "../src/lib/agent/nodes/planner";
import { agentGraph } from "../src/lib/agent/graph";

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

const allTrue: PlannerNeeds = {
  needs: { aiSuggestion: true, roadmap: true, resources: true, courses: true, skillFocus: true, agencies: true, nextSteps: true },
  reasoning: "test",
};
const allFalse: PlannerNeeds = {
  needs: { aiSuggestion: false, roadmap: false, resources: false, courses: false, skillFocus: false, agencies: false, nextSteps: false },
  reasoning: "test",
};

// ---------------------------------------------------------------------------
console.log("\n== A. Unit: gates ==");
check("agencyGate true for 'any career counsellor?'", agencyGate("I am confused. Any career counsellor?"));
check("agencyGate true for 'which agencies can help'", agencyGate("which agencies can help?"));
check("agencyGate false for 'what career path should I follow?'", !agencyGate("what career path should I follow?"));
check("agencyGate false for a bare 'help me choose'", !agencyGate("can you help me choose a career?"));
// Provider nouns from classifyIntent's agency_search definition. Omitting these
// vetoed asks the classifier itself labels agency_search.
check("agencyGate true for 'find me a recruiter'", agencyGate("find me a recruiter"));
check("agencyGate true for 'recruitment consultants'", agencyGate("any good recruitment firms?"));
check("agencyGate true for 'placement services near Pune'", agencyGate("any placement services near Pune?"));
check("agencyGate true for 'headhunter'", agencyGate("can a headhunter help me?"));
check("agencyGate true for 'staffing firm'", agencyGate("is a staffing firm worth it?"));
// Still a veto for asks that name no provider — the widening is category-complete,
// not category-broadening.
check("agencyGate false for 'how do I get hired at Google?'", !agencyGate("how do I get hired at Google?"));
check("agencyGate false for 'what skills should I learn?'", !agencyGate("what skills should I learn?"));
check("resourceGate true for 'suggest roadmap and courses'", resourceGate("suggest roadmap and courses"));
check("resourceGate true for 'how do I switch career in 6 months'", resourceGate("how do I switch career in 6 months?"));
check("resourceGate false for 'show me agencies'", !resourceGate("show me agencies"));

console.log("\n== A. Unit: finalizePlan gating ==");
{
  // agencies proposed but no provider term in query -> dropped
  const p = finalizePlan(allTrue, "what career path should I follow?");
  check("drops agencies when agencyGate fails", !p.sections.includes("agencies"), JSON.stringify(p.sections));
  check("keeps resources when resourceGate passes", p.sections.includes("resources"), JSON.stringify(p.sections));
}
{
  // pure agency lookup -> resources/courses dropped, agencies kept
  const p = finalizePlan(allTrue, "show me agencies");
  check("drops resources/courses on pure agency query", !p.sections.includes("resources") && !p.sections.includes("courses"), JSON.stringify(p.sections));
  check("keeps agencies on agency query", p.sections.includes("agencies"), JSON.stringify(p.sections));
}
{
  const p = finalizePlan(allFalse, "hello there");
  check("empty needs -> falls back to ['ai_suggestion']", p.sections.length === 1 && p.sections[0] === "ai_suggestion", JSON.stringify(p.sections));
}
{
  const p = finalizePlan(allTrue, "I want to become a data analyst. Suggest roadmap and courses.");
  check("stable section order", JSON.stringify(p.sections) === JSON.stringify(["ai_suggestion","roadmap","resources","courses","skill_focus","agencies","next_steps"].filter((s) => p.sections.includes(s as never))), JSON.stringify(p.sections));
}

// The fallback plan must FAIL CLOSED on agencies. finalizePlan gates agencies on
// `needs.agencies && agencyGate(query)`; if the fallback derived needs.agencies
// from the gate, that AND would collapse to `gate && gate` and a lone keyword
// would push agencies at a user who never asked for a provider.
console.log("\n== A. Unit: fallback plan fails closed on agencies ==");
{
  // Every query here PASSES agencyGate — including an explicit ask. With the
  // planner's judgment gone, none of them may surface agencies.
  const gatePassing = [
    "what guidance do you have for a fresher?",   // gate hit, but NOT asking for a provider
    "I'm a management consultant looking to switch to product",
    "I want to become a career coach",
    "can you suggest a career counsellor?",        // genuine ask: still fails closed
  ];
  for (const q of gatePassing) {
    check(`[${q.slice(0, 34)}…] agencyGate passes (precondition)`, agencyGate(q) === true);
    check(`[${q.slice(0, 34)}…] fallback needs.agencies false`, fallbackNeeds(q).needs.agencies === false);
    const p = finalizePlan(fallbackNeeds(q), q);
    check(`[${q.slice(0, 34)}…] fallback plan excludes agencies`, !p.sections.includes("agencies"), JSON.stringify(p.sections));
    check(`[${q.slice(0, 34)}…] still answers (≥1 section)`, p.sections.length >= 1, JSON.stringify(p.sections));
  }
}
{
  // The rest of the fallback still works — failing closed is scoped to agencies.
  const p = finalizePlan(fallbackNeeds("how do I learn SQL for a data analyst role?"), "how do I learn SQL for a data analyst role?");
  check("fallback keeps ai_suggestion", p.sections.includes("ai_suggestion"), JSON.stringify(p.sections));
  check("fallback keeps resources on a learning query", p.sections.includes("resources"), JSON.stringify(p.sections));
}

// ---------------------------------------------------------------------------
if (!process.env.GROQ_API_KEY) {
  console.log("\n== B. Live graph == (skipped: no GROQ_API_KEY)");
} else {
  console.log("\n== B. Live graph: gate invariants hold end-to-end ==");
  const FAKE_USER = "00000000-0000-0000-0000-000000000000"; // read-only; no such user is fine

  // Returns the planned sections plus whether the planner LLM was actually
  // available. When Groq is down or rate-limited the planner silently falls back
  // to the gate-safe regex plan — which, by design, fails closed on agencies. The
  // gate INVARIANTS below must still hold on a fallback plan, but the
  // planner-QUALITY expectations cannot: there was no planner to judge. Skipping
  // them beats a red suite that only means "the API is rate-limited".
  async function plan(query: string) {
    const out = await agentGraph.invoke({ userId: FAKE_USER, query, persist: false });
    const sections = out.plan?.sections ?? [];
    const reasoning = out.plan?.reasoning ?? "";
    const degraded = reasoning.startsWith("fallback plan");
    console.log(`\n[${query}]\n  -> ${JSON.stringify(sections)}  (${reasoning})`);
    return { sections, degraded };
  }

  const cases: Array<{ q: string; expectAgencies?: boolean; expectResourcesOrCourses?: boolean }> = [
    { q: "What career path should I follow?", expectAgencies: false },
    { q: "What career path should I follow and which agencies can help?", expectAgencies: true },
    { q: "I want to become a data analyst. Suggest roadmap and courses.", expectAgencies: false, expectResourcesOrCourses: true },
    { q: "I am confused between web development and data analytics. Any career counsellor?", expectAgencies: true },
    { q: "How do I switch career in 6 months?", expectAgencies: false },
    { q: "Show me agencies", expectAgencies: true },
    { q: "Show me courses", expectAgencies: false, expectResourcesOrCourses: true },
  ];

  let degradedRuns = 0;
  for (const c of cases) {
    const { sections: s, degraded } = await plan(c.q);
    const tag = c.q.slice(0, 32);
    // HARD invariants (deterministic, independent of LLM wording). These MUST
    // hold even on a fallback plan — that is the whole point of the gates.
    if (s.includes("agencies")) check(`[${tag}…] agencies ⟹ agencyGate`, agencyGate(c.q), JSON.stringify(s));
    if (s.includes("resources") || s.includes("courses")) check(`[${tag}…] resources/courses ⟹ resourceGate`, resourceGate(c.q), JSON.stringify(s));
    check(`[${tag}…] returns ≥1 section`, s.length >= 1, JSON.stringify(s));

    if (degraded) {
      // Planner unavailable. Assert the fail-closed contract instead of planner
      // quality: a fallback plan must never surface agencies, however explicitly
      // the query asked for them.
      degradedRuns++;
      check(`[${tag}…] degraded plan fails closed on agencies`, !s.includes("agencies"), JSON.stringify(s));
      continue;
    }

    // Expected behavior (relies on planner quality for clear asks):
    if (c.expectAgencies === true) check(`[${tag}…] includes agencies`, s.includes("agencies"), JSON.stringify(s));
    if (c.expectAgencies === false) check(`[${tag}…] excludes agencies`, !s.includes("agencies"), JSON.stringify(s));
    if (c.expectResourcesOrCourses) check(`[${tag}…] includes resources/courses`, s.includes("resources") || s.includes("courses"), JSON.stringify(s));
  }
  if (degradedRuns > 0) {
    console.log(`\n  NOTE: ${degradedRuns}/${cases.length} live runs used the FALLBACK plan (planner LLM`);
    console.log(`  unavailable — commonly a Groq rate limit). Gate invariants and the fail-closed`);
    console.log(`  contract were asserted; planner-quality expectations were not exercised.`);
  }
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
