// Recommendation Agent tests (multi-agent A2A refactor, step 4).
//
// Part A (default): PURE, deterministic assembly tests — no LLM, no DB. They prove
// the invention-safety and section-planning guarantees: only planned sections are
// returned; DB-backed sections (resources/courses/agencies) are exact subsets of
// the Career Data Agent input (no invented URLs/agencies); planned-but-empty
// sections carry clear notes; roadmap.suggested reflects resource availability; and
// the I/O contracts validate.
//
// Part B (opt-in): a live runRecommendationAgent run. DEFERRED by default (it makes
// an LLM call and the Groq daily-token quota is exhausted). Set RUN_LIVE_RECO=1 to
// run it once quota frees.
// Run: npm run test:reco     (Part A only; no keys needed)
//      RUN_LIVE_RECO=1 npm run test:reco   (adds Part B, needs GROQ_API_KEY)
import "dotenv/config";
import { SECTIONS } from "../src/lib/agent/schema";
import type { AgentPlan, SectionName } from "../src/lib/agent/schema";
import {
  assembleSections,
  buildContext,
  coerceTextSections,
  hasVerifiedResources,
  runRecommendationAgent,
  type TextSections,
} from "../src/lib/agent/agents/recommendation";
import {
  buildDialogueContext,
  DIALOGUE_CHAR_BUDGET,
  MAX_DIALOGUE_TURN_CHARS,
} from "../src/lib/conversations/dialogueContext";
import type { ChatTurn } from "../src/lib/ai/resolveQuery";
import {
  careerDataAgentOutputSchema,
  profileAgentOutputSchema,
} from "../src/lib/agent/agents/contracts";
import type {
  CareerDataAgentOutput,
  ProfileAgentOutput,
} from "../src/lib/agent/agents/contracts";

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

function plan(sections: SectionName[]): AgentPlan {
  return { sections, reasoning: "test" };
}

function sameSet(a: string[], b: string[]): boolean {
  const bs = new Set(b);
  return a.length === b.length && a.every((x) => bs.has(x));
}

// --- Fixtures (plain objects; satisfy the DTO contracts) ---
const careerData: CareerDataAgentOutput = {
  ragDocs: [{ id: "d1", type: "career_data", content: "SQL is core to analytics.", sourceUrl: "https://knowledge/1" }],
  resources: [
    { title: "Analytics Roadmap", type: "career_data", url: "https://res/roadmap" },
    { title: "SQL Guide", type: "career_data", url: "https://res/sql" },
  ],
  courses: [{ title: "Data Analytics Cert", type: "career_data", url: "https://course/da" }],
  agencies: [{ name: "Acme Careers", location: "Delhi", services: "counselling", website: "https://acme", source: "src/acme" }],
  sourcesUsed: [{ id: "d1", type: "career_data", sourceUrl: "https://knowledge/1" }],
  missingDataNotes: [],
  toolCalls: [],
};

const emptyCareerData: CareerDataAgentOutput = {
  ragDocs: [],
  resources: [],
  courses: [],
  agencies: [],
  sourcesUsed: [],
  missingDataNotes: [],
  toolCalls: [],
};

const text: TextSections = {
  ai_suggestion: "Focus on SQL and analytics fundamentals.",
  roadmap: ["Learn SQL", "Build a dashboard"],
  skill_focus: ["SQL (joins, aggregation)"],
  next_steps: ["Enrol in an analytics course"],
};

const resourceUrls = new Set([
  ...careerData.resources.map((r) => r.url),
  ...careerData.courses.map((c) => c.url),
]);
const agencyNames = new Set(careerData.agencies.map((a) => a.name));

console.log("\n== A. Pure assembly: section planning ==");
{
  const out = assembleSections(plan(["ai_suggestion", "resources"]), careerData, text, true);
  check("only planned sections returned", sameSet(Object.keys(out), ["ai_suggestion", "resources"]), JSON.stringify(Object.keys(out)));
  check("unplanned roadmap absent", out.roadmap === undefined);
  check("unplanned agencies absent", out.agencies === undefined);
}
{
  const full: SectionName[] = ["ai_suggestion", "roadmap", "resources", "courses", "skill_focus", "agencies", "next_steps"];
  const out = assembleSections(plan(full), careerData, text, true);
  check("all-planned -> keys equal the plan", sameSet(Object.keys(out), full), JSON.stringify(Object.keys(out)));
  check("output keys are all valid section names", Object.keys(out).every((k) => (SECTIONS as readonly string[]).includes(k)));
}

console.log("\n== A. Invention-safety: DB sections are subsets of Career Data input ==");
{
  const out = assembleSections(plan(["resources", "courses", "agencies"]), careerData, text, true);
  const outResUrls = (out.resources?.items ?? []).map((r) => r.url as string);
  const outCourseUrls = (out.courses?.items ?? []).map((c) => c.url as string);
  const outAgencyNames = (out.agencies?.items ?? []).map((a) => a.name);

  check("every resource URL comes from Career Data", outResUrls.every((u) => resourceUrls.has(u)), JSON.stringify(outResUrls));
  check("every course URL comes from Career Data", outCourseUrls.every((u) => resourceUrls.has(u)), JSON.stringify(outCourseUrls));
  check("no invented URLs at all", [...outResUrls, ...outCourseUrls].every((u) => resourceUrls.has(u)));
  check("every agency comes from Career Data", outAgencyNames.every((n) => agencyNames.has(n)), JSON.stringify(outAgencyNames));
  check("resource items exactly mirror the input", sameSet(outResUrls, careerData.resources.map((r) => r.url as string)));
  check("course items exactly mirror the input", sameSet(outCourseUrls, careerData.courses.map((c) => c.url as string)));
}

console.log("\n== A. Missing data -> clear notes ==");
{
  const out = assembleSections(plan(["resources", "courses", "agencies"]), emptyCareerData, text, false);
  check("empty resources -> items [] + note", (out.resources?.items.length === 0) && !!out.resources?.note, JSON.stringify(out.resources));
  check("resources note is explicit", (out.resources?.note ?? "").toLowerCase().includes("no verified resources"), out.resources?.note);
  check("empty courses -> note", (out.courses?.items.length === 0) && (out.courses?.note ?? "").toLowerCase().includes("no verified courses"), out.courses?.note);
  check("empty agencies -> note", (out.agencies?.items.length === 0) && (out.agencies?.note ?? "").toLowerCase().includes("no verified agencies"), out.agencies?.note);
}

console.log("\n== A. Text passthrough + roadmap.suggested ==");
{
  const out = assembleSections(plan(["ai_suggestion", "roadmap", "skill_focus", "next_steps"]), careerData, text, true);
  check("ai_suggestion passes through", out.ai_suggestion === text.ai_suggestion);
  check("roadmap items pass through", sameSet(out.roadmap?.items ?? [], text.roadmap ?? []));
  check("skill_focus passes through", sameSet(out.skill_focus ?? [], text.skill_focus ?? []));
  check("next_steps passes through", sameSet(out.next_steps ?? [], text.next_steps ?? []));
  check("roadmap.suggested=false when resources available", out.roadmap?.suggested === false);

  const out2 = assembleSections(plan(["roadmap"]), emptyCareerData, text, false);
  check("roadmap.suggested=true when no resources", out2.roadmap?.suggested === true);
}

console.log("\n== A. Empty text (LLM failure) -> safe empties ==");
{
  const out = assembleSections(plan(["ai_suggestion", "roadmap"]), careerData, {}, true);
  check("ai_suggestion falls back to empty string", out.ai_suggestion === "");
  check("roadmap falls back to empty items", (out.roadmap?.items.length ?? -1) === 0);
}

console.log("\n== A. hasVerifiedResources derivation ==");
{
  check("true when resources present", hasVerifiedResources(careerData) === true);
  check("false when none present", hasVerifiedResources(emptyCareerData) === false);
  check("true when only courses present", hasVerifiedResources({ ...emptyCareerData, courses: [{ title: "C", type: "career_data", url: "https://c" }] }) === true);
}

console.log("\n== A. External sourced results injected into grounding context ==");
{
  const cdExternal: CareerDataAgentOutput = {
    ...emptyCareerData,
    roadmaps: [
      { title: "Data Analyst Roadmap", url: "https://roadmap.sh/data-analyst", source: "roadmap.sh", snippet: "Step-by-step path from beginner to analyst.", publishedDate: null, score: 0.9 },
    ],
    marketSignals: [
      { title: "Analytics hiring is up 12% YoY", url: "https://linkedin.com/report", source: "linkedin.com", snippet: "Demand for analysts grew across sectors.", publishedDate: "2025-02-01", score: 0.8 },
    ],
    industryArticles: [
      { title: "The state of data work in 2025", url: "https://mckinsey.com/insights/data", source: "mckinsey.com", snippet: "How organizations are restructuring analytics teams.", publishedDate: "2025-01-01", score: 0.7 },
    ],
  };
  const profile: ProfileAgentOutput = {
    profileSummary: "Job switcher; skills: Excel.",
    memorySummary: "No stored memory for this user.",
    userContext: { stage: "job_switcher", currentRole: null, skills: ["Excel"], interests: [], careerGoal: null, location: null },
    importantConstraints: [],
  };
  const ctx = buildContext(profile, cdExternal);
  check("context has an EXTERNAL SOURCED REFERENCES block", ctx.includes("EXTERNAL SOURCED REFERENCES"), ctx);
  check("lane labels present", ctx.includes("Career roadmaps") && ctx.includes("Labor-market signals") && ctx.includes("Industry articles"));
  check("external title cited", ctx.includes("Data Analyst Roadmap"));
  check("external url cited (grounding link)", ctx.includes("https://roadmap.sh/data-analyst"));
  check("external source label cited", ctx.includes("mckinsey.com"));
  check("external snippet included", ctx.includes("Demand for analysts grew"));

  // Empty external -> no block, and skipped lanes are omitted individually.
  const ctxNone = buildContext(profile, emptyCareerData);
  check("no external block when there are no external results", !ctxNone.includes("EXTERNAL SOURCED REFERENCES"), ctxNone);
  const ctxRoadmapsOnly = buildContext(profile, { ...emptyCareerData, roadmaps: cdExternal.roadmaps });
  check("only non-empty lanes render", ctxRoadmapsOnly.includes("Career roadmaps") && !ctxRoadmapsOnly.includes("Labor-market signals"));
}

console.log("\n== A. Schema-mismatch repair (coerceTextSections) ==");
{
  // On-spec output passes through untouched.
  const ok = coerceTextSections(
    { ai_suggestion: "Cyber security salaries vary by role.", roadmap: ["Learn networking"] },
    ["ai_suggestion", "roadmap"]
  );
  check("on-spec output passes through", ok.ai_suggestion === "Cyber security salaries vary by role.");
  check("on-spec array passes through", sameSet(ok.roadmap ?? [], ["Learn networking"]));

  // The reported failure: plan wants ai_suggestion only, model nests the others inside it.
  const nested = coerceTextSections(
    {
      ai_suggestion: {
        roadmap: ["Start with SOC analyst roles"],
        skill_focus: ["Networking"],
        next_steps: ["Compare salary bands"],
      },
    },
    ["ai_suggestion"]
  );
  check("nested object recovered as prose", typeof nested.ai_suggestion === "string" && nested.ai_suggestion.length > 0, JSON.stringify(nested));
  check("nested content is not lost", (nested.ai_suggestion ?? "").includes("SOC analyst"), nested.ai_suggestion);
  check("unrequested keys dropped", sameSet(Object.keys(nested), ["ai_suggestion"]), JSON.stringify(Object.keys(nested)));

  // Envelope wrapper.
  const wrapped = coerceTextSections(
    { response: { ai_suggestion: "Salaries range widely.", next_steps: ["Research bands"] } },
    ["ai_suggestion", "next_steps"]
  );
  check("envelope unwrapped", wrapped.ai_suggestion === "Salaries range widely.");
  check("envelope sibling array recovered", sameSet(wrapped.next_steps ?? [], ["Research bands"]));

  // Type slips: string where an array was asked for, objects inside an array.
  const slipped = coerceTextSections(
    { roadmap: "Learn networking", skill_focus: [{ skill: "SIEM", why: "core to SOC work" }] },
    ["roadmap", "skill_focus"]
  );
  check("string coerced to a single-item array", sameSet(slipped.roadmap ?? [], ["Learn networking"]), JSON.stringify(slipped.roadmap));
  check("object list item flattened to text", (slipped.skill_focus ?? []).some((s) => s.includes("SIEM")), JSON.stringify(slipped.skill_focus));

  // Requested-but-absent keys stay absent (assembly supplies the safe empty).
  const partial = coerceTextSections({ ai_suggestion: "Only this." }, ["ai_suggestion", "roadmap"]);
  check("absent requested key omitted", partial.roadmap === undefined);

  // Unrecoverable payload -> empty, not a crash.
  check("garbage payload -> {}", Object.keys(coerceTextSections("nope", ["ai_suggestion"])).length === 0);
  check("null payload -> {}", Object.keys(coerceTextSections(null, ["ai_suggestion"])).length === 0);

  // Requested keys are never invented from unrequested siblings.
  const extra = coerceTextSections(
    { ai_suggestion: "Answer.", agencies: ["Invented Co"] },
    ["ai_suggestion"]
  );
  check("non-text sibling ignored", sameSet(Object.keys(extra), ["ai_suggestion"]), JSON.stringify(Object.keys(extra)));
}

console.log("\n== A. Dialogue context: budget-bounded continuity block (6b) ==");
{
  // Empty / absent history -> "" so the caller can omit the block and its framing.
  check("empty history -> empty string", buildDialogueContext([]) === "");

  const short: ChatTurn[] = [
    { role: "user", content: "I want to switch to analytics." },
    { role: "assistant", content: "Analytics is a strong fit; start with SQL." },
    { role: "user", content: "And the roadmap for that?" },
  ];
  const block = buildDialogueContext(short);
  check("small history fits without omission note", !block.includes("omitted"), block);
  check("role labels rendered", block.includes("User:") && block.includes("Assistant:"), block);
  check(
    "chronological order preserved (oldest first)",
    block.indexOf("switch to analytics") < block.indexOf("roadmap for that"),
    block
  );

  // Budget enforcement: many long turns -> total stays within budget, oldest dropped,
  // truncation is announced, and the NEWEST turn survives.
  const long: ChatTurn[] = Array.from({ length: 20 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as ChatTurn["role"],
    content: `Turn ${i} ` + "x".repeat(300),
  }));
  const bounded = buildDialogueContext(long);
  check("bounded within char budget", bounded.length <= DIALOGUE_CHAR_BUDGET + 80, String(bounded.length));
  check("truncation announced when turns dropped", bounded.includes("omitted"), bounded.slice(0, 60));
  check("newest turn kept under budget pressure", bounded.includes("Turn 19"), bounded);
  check("oldest turn dropped under budget pressure", !bounded.includes("Turn 0 "), bounded.slice(0, 120));

  // Never drop the newest turn to nothing, even with an absurdly small budget.
  const tiny = buildDialogueContext(short, 5);
  check("newest turn always kept (tiny budget)", tiny.includes("roadmap for that"), tiny);
  check("tiny budget still announces omission", tiny.includes("omitted"), tiny);

  // Per-turn clip caps a single huge turn (ellipsis appended).
  const huge: ChatTurn[] = [{ role: "user", content: "y".repeat(MAX_DIALOGUE_TURN_CHARS + 500) }];
  const clipped = buildDialogueContext(huge);
  check("over-long turn clipped to per-turn cap", clipped.length <= MAX_DIALOGUE_TURN_CHARS + "User: ".length + 2, String(clipped.length));
  check("clip marked with ellipsis", clipped.includes("…"), clipped.slice(-10));
}

console.log("\n== A. Contract validation (I/O DTOs) ==");
{
  check("valid Career Data input validates", careerDataAgentOutputSchema.safeParse(careerData).success);
  check("malformed Career Data input rejected", !careerDataAgentOutputSchema.safeParse({ ...careerData, resources: [{ title: 1 }] }).success);
  const profile: ProfileAgentOutput = {
    profileSummary: "Job switcher; skills: Excel.",
    memorySummary: "No stored memory for this user.",
    userContext: { stage: "job_switcher", currentRole: null, skills: ["Excel"], interests: [], careerGoal: null, location: null },
    importantConstraints: [],
  };
  check("valid Profile input validates", profileAgentOutputSchema.safeParse(profile).success);
}

// --- Part B: opt-in live run (deferred by default; Groq daily quota) ---
if (process.env.RUN_LIVE_RECO === "1") {
  console.log("\n== B. Live runRecommendationAgent ==");
  const profile: ProfileAgentOutput = {
    profileSummary: "Job switcher; currently Sales Executive; skills: Excel, CRM; goal: business analytics.",
    memorySummary: "No stored memory for this user.",
    userContext: { stage: "job_switcher", currentRole: "Sales Executive", skills: ["Excel", "CRM"], interests: ["Analytics"], careerGoal: "business analytics", location: "Pune" },
    importantConstraints: ["User prefers roles with little to no coding."],
  };
  const p = plan(["ai_suggestion", "roadmap", "resources", "courses", "skill_focus", "next_steps"]);
  const out = await runRecommendationAgent({ query: "How do I switch to analytics?", intent: "career_advice", plan: p, profile, careerData });

  check("draft has exactly the planned sections", sameSet(Object.keys(out.draftSections), p.sections), JSON.stringify(Object.keys(out.draftSections)));
  const liveResUrls = [
    ...(out.draftSections.resources?.items ?? []).map((r) => r.url as string),
    ...(out.draftSections.courses?.items ?? []).map((c) => c.url as string),
  ];
  check("live run invents no URLs", liveResUrls.every((u) => resourceUrls.has(u)), JSON.stringify(liveResUrls));
  check("ai_suggestion is a string", typeof out.draftSections.ai_suggestion === "string");
} else {
  console.log("\n== B. Live runRecommendationAgent: SKIPPED (set RUN_LIVE_RECO=1; deferred — Groq daily quota) ==");
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
