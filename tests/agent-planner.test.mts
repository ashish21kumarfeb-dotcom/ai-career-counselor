// Planner tests for the agentic-chat POC step (b). Two parts:
//   A) deterministic unit tests for the gates + finalizePlan (no LLM, no DB)
//   B) live graph runs (intent -> context -> planner) asserting the gate
//      INVARIANTS hold end-to-end (requires GROQ_API_KEY + DATABASE_URL)
// Run: npm run test:planner
import "dotenv/config";
import { agencyGate, resourceGate, finalizePlan, type PlannerNeeds } from "../src/lib/agent/schema";
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
  needs: { aiSuggestion: true, roadmap: true, resources: true, courses: true, agencies: true, nextSteps: true },
  reasoning: "test",
};
const allFalse: PlannerNeeds = {
  needs: { aiSuggestion: false, roadmap: false, resources: false, courses: false, agencies: false, nextSteps: false },
  reasoning: "test",
};

// ---------------------------------------------------------------------------
console.log("\n== A. Unit: gates ==");
check("agencyGate true for 'any career counsellor?'", agencyGate("I am confused. Any career counsellor?"));
check("agencyGate true for 'which agencies can help'", agencyGate("which agencies can help?"));
check("agencyGate false for 'what career path should I follow?'", !agencyGate("what career path should I follow?"));
check("agencyGate false for a bare 'help me choose'", !agencyGate("can you help me choose a career?"));
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
  check("stable section order", JSON.stringify(p.sections) === JSON.stringify(["ai_suggestion","roadmap","resources","courses","agencies","next_steps"].filter((s) => p.sections.includes(s as never))), JSON.stringify(p.sections));
}

// ---------------------------------------------------------------------------
if (!process.env.GROQ_API_KEY) {
  console.log("\n== B. Live graph == (skipped: no GROQ_API_KEY)");
} else {
  console.log("\n== B. Live graph: gate invariants hold end-to-end ==");
  const FAKE_USER = "00000000-0000-0000-0000-000000000000"; // read-only; no such user is fine

  async function plan(query: string) {
    const out = await agentGraph.invoke({ userId: FAKE_USER, query, persist: false });
    const sections = out.plan?.sections ?? [];
    console.log(`\n[${query}]\n  -> ${JSON.stringify(sections)}  (${out.plan?.reasoning ?? ""})`);
    return sections;
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

  for (const c of cases) {
    const s = await plan(c.q);
    // HARD invariants (deterministic, independent of LLM wording):
    if (s.includes("agencies")) check(`[${c.q.slice(0, 32)}…] agencies ⟹ agencyGate`, agencyGate(c.q), JSON.stringify(s));
    if (s.includes("resources") || s.includes("courses")) check(`[${c.q.slice(0, 32)}…] resources/courses ⟹ resourceGate`, resourceGate(c.q), JSON.stringify(s));
    check(`[${c.q.slice(0, 32)}…] returns ≥1 section`, s.length >= 1, JSON.stringify(s));
    // Expected behavior (relies on planner quality for clear asks):
    if (c.expectAgencies === true) check(`[${c.q.slice(0, 32)}…] includes agencies`, s.includes("agencies"), JSON.stringify(s));
    if (c.expectAgencies === false) check(`[${c.q.slice(0, 32)}…] excludes agencies`, !s.includes("agencies"), JSON.stringify(s));
    if (c.expectResourcesOrCourses) check(`[${c.q.slice(0, 32)}…] includes resources/courses`, s.includes("resources") || s.includes("courses"), JSON.stringify(s));
  }
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
