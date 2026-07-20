// Generate/verify tests for the agentic-chat POC step (d). Two parts:
//   A) deterministic units for buildDbSections (no LLM): DB-backed sections are
//      mapped from tool results, bucketed resources vs courses, and empty ->
//      explicit "no verified data" note.
//   B) live full-graph runs asserting the generated response has only the planned
//      sections, DB sections carry notes when empty, roadmap.suggested reflects
//      resource availability, and a verification verdict is recorded.
// Run: npm run test:generate   (Part B requires GROQ_API_KEY + DATABASE_URL)
import "dotenv/config";
import { buildDbSections } from "../src/lib/agent/sections";
import { agentGraph } from "../src/lib/agent/graph";
import type { RetrievedDocument } from "../src/lib/documents/queries";
import type { RetrievedAgency } from "../src/lib/agencies/queries";

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

const agency: RetrievedAgency = {
  id: "a1", name: "Sample Agency", location: "Delhi",
  services: "career counselling", website: "https://example.com/a", sourceUrl: "internal-seed/a",
};
const roadmapDoc: RetrievedDocument = {
  id: "d1", type: "career_data", sourceUrl: "https://roadmap.sh/data-analyst",
  content: "Data analyst roadmap: spreadsheets, SQL, Python, and a BI tool.",
};
const courseDoc: RetrievedDocument = {
  id: "d2", type: "career_data", sourceUrl: "https://grow.google/certificates/data-analytics/",
  content: "Google Data Analytics Professional Certificate: beginner program.",
};
const mdnDoc: RetrievedDocument = {
  id: "d3", type: "industry_article", sourceUrl: "https://developer.mozilla.org/en-US/docs/Learn",
  content: "MDN Learn Web Development: guides for HTML, CSS, and JavaScript.",
};

// ---------------------------------------------------------------------------
console.log("\n== A. Unit: buildDbSections ==");
{
  const r = buildDbSections(["agencies"], [], []);
  check("agencies planned + empty -> note", r.agencies?.items.length === 0 && !!r.agencies?.note, JSON.stringify(r.agencies));
}
{
  const r = buildDbSections(["agencies"], [agency], []);
  check("agencies planned + data -> items, no note", r.agencies?.items.length === 1 && !r.agencies?.note, JSON.stringify(r.agencies));
  check("agency item is DB-sourced (has source)", r.agencies?.items[0]?.source === "internal-seed/a");
}
{
  const r = buildDbSections(["resources", "courses"], [], [roadmapDoc, courseDoc, mdnDoc]);
  const resUrls = r.resources?.items.map((i) => i.url) ?? [];
  const courseUrls = r.courses?.items.map((i) => i.url) ?? [];
  check("courses gets the course-like doc", courseUrls.includes("https://grow.google/certificates/data-analytics/"), JSON.stringify(courseUrls));
  check("resources gets roadmap + MDN (non-course)", resUrls.includes("https://roadmap.sh/data-analyst") && resUrls.includes("https://developer.mozilla.org/en-US/docs/Learn"), JSON.stringify(resUrls));
  check("no link appears in both buckets", !resUrls.some((u) => courseUrls.includes(u)));
}
{
  const r = buildDbSections(["resources"], [], [roadmapDoc, courseDoc]);
  check("resources-only gets ALL docs", r.resources?.items.length === 2 && !r.courses, JSON.stringify(r.resources?.items.length));
}
{
  const r = buildDbSections(["courses"], [], [roadmapDoc, courseDoc]);
  check("courses-only gets only course-like", r.courses?.items.length === 1 && !r.resources, JSON.stringify(r.courses?.items.length));
}
{
  const r = buildDbSections(["ai_suggestion"], [agency], [roadmapDoc]);
  check("unplanned DB sections absent", !r.agencies && !r.resources && !r.courses);
}

// ---------------------------------------------------------------------------
if (!process.env.GROQ_API_KEY) {
  console.log("\n== B. Live graph == (skipped: no GROQ_API_KEY)");
} else {
  console.log("\n== B. Live full graph ==");
  const FAKE_USER = "00000000-0000-0000-0000-000000000000";

  {
    const out = await agentGraph.invoke({ userId: FAKE_USER, query: "I want to become a data analyst. Suggest roadmap and courses.", persist: false });
    const s = out.sections!;
    const planned = out.plan!.sections;
    console.log(`  plan: ${JSON.stringify(planned)}`);
    check("sections keys match the plan exactly", Object.keys(s).sort().join(",") === [...planned].sort().join(","), `${Object.keys(s)} vs ${planned}`);
    check("ai_suggestion is a non-empty string", typeof s.ai_suggestion === "string" && s.ai_suggestion.length > 0);
    check("roadmap has steps", (s.roadmap?.items.length ?? 0) >= 1, JSON.stringify(s.roadmap));
    check("roadmap.suggested=false when resources retrieved", s.roadmap?.suggested === false, JSON.stringify(s.roadmap?.suggested));
    const resItems = [...(s.resources?.items ?? []), ...(s.courses?.items ?? [])];
    check("resource/course items are real http links (not invented)", resItems.length > 0 && resItems.every((i) => (i.url ?? "").startsWith("http")), JSON.stringify(resItems.map((i) => i.url)));
    check("no agencies section (not asked)", !("agencies" in s));
    if ("skill_focus" in s) {
      check("skill_focus is a non-empty string array", Array.isArray(s.skill_focus) && s.skill_focus.length > 0 && s.skill_focus.every((x) => typeof x === "string"), JSON.stringify(s.skill_focus));
    } else {
      check("skill_focus section (skipped: planner did not request it)", true);
    }
    check("verification recorded with booleans", typeof out.verification?.grounded === "boolean" && typeof out.verification?.safe === "boolean", JSON.stringify(out.verification));
  }

  {
    // "counsellor" passes agencyGate but does NOT substring-match any seeded
    // agency's services ("counselling"), and the rest is nonsense -> empty result.
    const out = await agentGraph.invoke({ userId: FAKE_USER, query: "I need a career counsellor for zzqwxy zzblort.", persist: false });
    const s = out.sections!;
    console.log(`  plan: ${JSON.stringify(out.plan!.sections)}  | agencies: ${JSON.stringify(s.agencies)}`);
    if ("agencies" in s) {
      check("empty agencies -> items [] with a 'no verified' note", s.agencies!.items.length === 0 && typeof s.agencies!.note === "string" && s.agencies!.note.length > 0, JSON.stringify(s.agencies));
    } else {
      check("agencies section (skipped: planner did not request it)", true);
    }
  }
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
