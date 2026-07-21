// Verification Agent tests (multi-agent A2A refactor, step 5). Fully deterministic:
// the soft LLM check is dependency-injected with stubs, so every branch (clean /
// unsafe / unavailable) is exercised without any LLM or DB call.
// Run: npm run test:verify
//
// The "no DB call" above is still true of the TEST — but the module under test
// imports createCompletion, which imports the db client, which throws at module
// load when DATABASE_URL is unset. Loading dotenv satisfies the import graph
// without giving this suite any actual database dependency.
import "dotenv/config";
import {
  runVerificationAgent,
  sanitizeDraft,
  externalProviderLabels,
  SAFE_FALLBACK_TEXT,
  type SoftCheckResult,
} from "../src/lib/agent/agents/verification";
import type { AgentPlan, ResponseSections, SectionName } from "../src/lib/agent/schema";
import type { CareerDataAgentOutput, VerificationAgentInput } from "../src/lib/agent/agents/contracts";

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

// Injectable soft-check stubs (no LLM).
const softOk: () => Promise<SoftCheckResult> = async () => ({ available: true, grounded: true, safe: true, notes: "looks grounded" });
const softUnsafe: () => Promise<SoftCheckResult> = async () => ({ available: true, grounded: true, safe: false, notes: "guarantees a job" });
const softUnavailable: () => Promise<SoftCheckResult> = async () => ({ available: false, grounded: false, safe: false, notes: "LLM error" });

// Career Data fixture: the ONLY verified data that may appear downstream.
const careerData: CareerDataAgentOutput = {
  ragDocs: [{ id: "d1", type: "career_data", content: "SQL matters.", sourceUrl: "https://k/1" }],
  resources: [{ title: "Roadmap", type: "career_data", url: "https://res/roadmap" }],
  courses: [{ title: "DA Cert", type: "career_data", url: "https://course/da" }],
  agencies: [{ name: "Acme Careers", location: "Delhi", services: "counselling", website: "https://acme", source: "src/acme" }],
  sourcesUsed: [],
  missingDataNotes: [],
  toolCalls: [],
};

const A1 = careerData.agencies[0];
const R1 = careerData.resources[0];
const C1 = careerData.courses[0];

function plan(sections: SectionName[]): AgentPlan {
  return { sections, reasoning: "test" };
}
function input(sections: SectionName[], draftSections: ResponseSections): VerificationAgentInput {
  return { query: "help me switch to analytics", plan: plan(sections), draftSections, careerData };
}

// A clean, fully-valid draft (everything traces to careerData).
function cleanDraft(): ResponseSections {
  return {
    ai_suggestion: "Focus on SQL.",
    roadmap: { items: ["Learn SQL"], suggested: false },
    resources: { items: [{ ...R1 }] },
    courses: { items: [{ ...C1 }] },
    skill_focus: ["SQL"],
    agencies: { items: [{ ...A1 }] },
    next_steps: ["Enrol"],
  };
}
const ALL: SectionName[] = ["ai_suggestion", "roadmap", "resources", "courses", "skill_focus", "agencies", "next_steps"];

console.log("\n== clean draft -> approved ==");
{
  const out = await runVerificationAgent(input(ALL, cleanDraft()), { softCheck: softOk });
  check("approved true", out.approved === true);
  check("no issues", out.issues.length === 0, JSON.stringify(out.issues));
  check("soft check available", out.softCheckAvailable === true);
  check("grounded + safe true", out.grounded === true && out.safe === true);
  check("finalSections keep the valid resource", out.finalSections.resources?.items[0]?.url === R1.url);
}

console.log("\n== invented agency -> approved false + sanitized ==");
{
  const draft = cleanDraft();
  draft.agencies = { items: [{ ...A1 }, { name: "Ghost Agency", location: null, services: null, website: "https://ghost", source: "src/ghost" }] };
  const out = await runVerificationAgent(input(ALL, draft), { softCheck: softOk });
  const names = (out.finalSections.agencies?.items ?? []).map((a) => a.name);
  check("approved false", out.approved === false);
  check("invented agency removed", !names.includes("Ghost Agency") && names.includes("Acme Careers"), JSON.stringify(names));
  check("issue records the removal", out.issues.some((i) => i.toLowerCase().includes("agency")), JSON.stringify(out.issues));
}

console.log("\n== invented resource URL -> approved false + sanitized ==");
{
  const draft = cleanDraft();
  draft.resources = { items: [{ ...R1 }, { title: "Evil", type: "career_data", url: "https://evil/phish" }] };
  const out = await runVerificationAgent(input(ALL, draft), { softCheck: softOk });
  const urls = (out.finalSections.resources?.items ?? []).map((r) => r.url);
  check("approved false", out.approved === false);
  check("invented URL removed", !urls.includes("https://evil/phish") && urls.includes(R1.url), JSON.stringify(urls));
  check("issue records the removal", out.issues.some((i) => i.toLowerCase().includes("resource")), JSON.stringify(out.issues));
}

console.log("\n== invented course URL -> approved false + sanitized ==");
{
  const draft = cleanDraft();
  draft.courses = { items: [{ ...C1 }, { title: "Fake Cert", type: "career_data", url: "https://fake/cert" }] };
  const out = await runVerificationAgent(input(ALL, draft), { softCheck: softOk });
  const urls = (out.finalSections.courses?.items ?? []).map((c) => c.url);
  check("approved false", out.approved === false);
  check("invented course URL removed", !urls.includes("https://fake/cert") && urls.includes(C1.url), JSON.stringify(urls));
}

console.log("\n== unplanned section -> removed + issue ==");
{
  // plan omits resources, but the draft includes a resources section.
  const out = await runVerificationAgent(input(["ai_suggestion"], { ai_suggestion: "hi", resources: { items: [{ ...R1 }] } }), { softCheck: softOk });
  check("unplanned section removed", out.finalSections.resources === undefined);
  check("issue records unplanned removal", out.issues.some((i) => i.toLowerCase().includes("unplanned")), JSON.stringify(out.issues));
  check("approved false (hard issue)", out.approved === false);
  check("finalSections keys are a subset of the plan", Object.keys(out.finalSections).every((k) => (["ai_suggestion"] as string[]).includes(k)));
}

console.log("\n== missing / empty sections handled safely ==");
{
  // Previously asserted "empty draft ... approves". That WAS the bug: an empty
  // answer is not an answer, and approving it meant the regeneration loop never
  // fired on the one failure mode that most deserves it.
  const out1 = await runVerificationAgent(input(["ai_suggestion", "resources"], {}), { softCheck: softOk });
  check("empty draft does not throw", out1.finalSections !== undefined);
  check("empty planned text is REJECTED, not approved", out1.approved === false);
  check("issue names the empty section", out1.issues.some((i) => i.includes("came back empty")), JSON.stringify(out1.issues));

  const out2 = await runVerificationAgent(input(["resources"], { resources: { items: [], note: "No verified resources found for this query." } }), { softCheck: softOk });
  check("empty planned section kept, no false invention", out2.approved === true && out2.finalSections.resources?.items.length === 0);
}

console.log("\n== planned free-text that came back EMPTY is rejected ==");
{
  // The exact shape assembleSections emits when the LLM call failed: the planned
  // keys are present, the content is not.
  const gutted: ResponseSections = {
    ai_suggestion: "",
    roadmap: { items: [], suggested: true },
    skill_focus: [],
    next_steps: [],
  };
  const out = await runVerificationAgent(input(["ai_suggestion", "roadmap", "skill_focus", "next_steps"], gutted), { softCheck: softOk });
  check("approved false", out.approved === false);
  check("every empty planned section named", ["ai_suggestion", "roadmap", "skill_focus", "next_steps"].every((s) => out.issues.some((i) => i.includes(s))), JSON.stringify(out.issues));
  check("feedback tells the model to produce content", /empty or omitted section is not an answer/i.test(out.recommendedFix ?? ""), out.recommendedFix);
}
{
  // Whitespace is not content.
  const out = await runVerificationAgent(input(["ai_suggestion"], { ai_suggestion: "   \n  " }), { softCheck: softOk });
  check("whitespace-only text rejected", out.approved === false, JSON.stringify(out.issues));
}
{
  // Deterministic by necessity: text generation fails exactly when the soft check
  // is most likely to be unavailable too.
  const out = await runVerificationAgent(input(["ai_suggestion"], { ai_suggestion: "" }), { softCheck: softUnavailable });
  check("caught with the soft check unavailable", out.approved === false, JSON.stringify(out.issues));
}
{
  // A DB-only plan legitimately has no free text — that must still approve.
  const out = await runVerificationAgent(input(["agencies"], { agencies: { items: [{ ...A1 }] } }), { softCheck: softOk });
  check("DB-only plan with no text sections still approves", out.approved === true, JSON.stringify(out.issues));
}
{
  // A section that is populated must not be flagged just because a sibling is not.
  const out = await runVerificationAgent(input(["ai_suggestion", "roadmap"], { ai_suggestion: "Real advice.", roadmap: { items: [], suggested: true } }), { softCheck: softOk });
  check("only the empty section is flagged", out.issues.filter((i) => i.includes("came back empty")).length === 1, JSON.stringify(out.issues));
  check("issue names roadmap, not ai_suggestion", out.issues.some((i) => i.includes("roadmap") && !i.includes("ai_suggestion")), JSON.stringify(out.issues));
}
{
  // Ordering: the invented-provider check DELETES free text. If the empty check
  // ran after it, sanitization would report itself as empty output.
  const draft: ResponseSections = { ai_suggestion: "Contact ABC Career Consultancy today.", roadmap: { items: ["step"], suggested: true } };
  const out = await runVerificationAgent(
    { query: "q", plan: plan(["ai_suggestion", "roadmap"]), draftSections: draft, careerData: { ...careerData, agencies: [] } },
    { softCheck: softOk }
  );
  check("provider removal does not cascade into a false 'empty' issue", !out.issues.some((i) => i.includes("came back empty")), JSON.stringify(out.issues));
  check("the provider issue is still reported", out.issues.some((i) => i.includes("ABC Career Consultancy")), JSON.stringify(out.issues));
}

console.log("\n== soft unavailable does NOT default to grounded/safe true ==");
{
  const out = await runVerificationAgent(input(ALL, cleanDraft()), { softCheck: softUnavailable });
  check("softCheckAvailable false", out.softCheckAvailable === false);
  check("grounded NOT true", out.grounded === false);
  check("safe NOT true", out.safe === false);
  check("still approved (deterministic passed)", out.approved === true);
  check("notes state soft check unavailable", out.verificationNotes.toLowerCase().includes("not available") || out.issues.some((i) => i.toLowerCase().includes("unavailable")), out.verificationNotes);
}

console.log("\n== unsafe soft result -> fallback text ==");
{
  const out = await runVerificationAgent(input(ALL, cleanDraft()), { softCheck: softUnsafe });
  check("approved false", out.approved === false);
  check("ai_suggestion replaced with safe fallback", out.finalSections.ai_suggestion === SAFE_FALLBACK_TEXT);
  check("roadmap free-text removed", out.finalSections.roadmap === undefined);
  check("next_steps removed", out.finalSections.next_steps === undefined);
  check("verified DB sections kept", out.finalSections.resources?.items[0]?.url === R1.url && out.finalSections.agencies?.items[0]?.name === "Acme Careers");
  check("issue records unsafe flag", out.issues.some((i) => i.toLowerCase().includes("unsafe")));
}

console.log("\n== finalSections never contain data outside Career Data (combined) ==");
{
  const draft: ResponseSections = {
    ai_suggestion: "hi",
    resources: { items: [{ ...R1 }, { title: "X", type: "career_data", url: "https://evil" }] },
    courses: { items: [{ ...C1 }, { title: "Y", type: "career_data", url: "https://fake" }] },
    agencies: { items: [{ ...A1 }, { name: "Ghost", location: null, services: null, website: null, source: "ghost" }] },
    next_steps: ["step"], // unplanned below
  };
  const out = await runVerificationAgent(input(["ai_suggestion", "resources", "courses", "agencies"], draft), { softCheck: softOk });

  const allowedRes = new Set(careerData.resources.map((r) => r.url));
  const allowedCourse = new Set(careerData.courses.map((c) => c.url));
  const allowedAgency = new Set(careerData.agencies.map((a) => a.name));
  const okRes = (out.finalSections.resources?.items ?? []).every((r) => allowedRes.has(r.url));
  const okCourse = (out.finalSections.courses?.items ?? []).every((c) => allowedCourse.has(c.url));
  const okAgency = (out.finalSections.agencies?.items ?? []).every((a) => allowedAgency.has(a.name));
  const keysSubset = Object.keys(out.finalSections).every((k) => ["ai_suggestion", "resources", "courses", "agencies"].includes(k));

  check("all resources trace to Career Data", okRes);
  check("all courses trace to Career Data", okCourse);
  check("all agencies trace to Career Data", okAgency);
  check("no unplanned sections remain (next_steps removed)", keysSubset && out.finalSections.next_steps === undefined);
  check("approved false (multiple hard issues)", out.approved === false);
}

console.log("\n== sanitizeDraft is pure (input unchanged) ==");
{
  const draft = cleanDraft();
  draft.resources = { items: [{ ...R1 }, { title: "Evil", type: "career_data", url: "https://evil" }] };
  const before = JSON.stringify(draft);
  const { finalSections } = sanitizeDraft(input(ALL, draft));
  check("original draft not mutated", JSON.stringify(draft) === before);
  check("sanitized copy has the invented URL removed", (finalSections.resources?.items ?? []).every((r) => r.url !== "https://evil"));
}

// --- Free-text provider invention (the prose channel) --------------------------
// agencyGate can veto the agencies SECTION while the LLM names a provider in a
// sentence. The DB-backed subset checks never read prose, and the soft check is
// allowed to be unavailable — so this must be caught deterministically.
const noAgencies: CareerDataAgentOutput = { ...careerData, agencies: [] };

console.log("\n== invented provider named in prose -> removed ==");
{
  // The gap-1 scenario: a plain career question, agencyGate vetoed, zero verified
  // agencies — yet the model names a firm. softOk = the soft check is WORKING and
  // says safe, proving the deterministic layer catches this on its own.
  const draft: ResponseSections = {
    ai_suggestion: "Learn SQL and Power BI. You could also reach out to ABC Career Consultancy in Pune for placement help.",
    roadmap: { items: ["Learn SQL"], suggested: true },
  };
  const out = await runVerificationAgent(
    { query: "how do I switch from testing to data analysis?", plan: plan(["ai_suggestion", "roadmap"]), draftSections: draft, careerData: noAgencies },
    { softCheck: softOk }
  );
  check("approved false", out.approved === false);
  check("provider no longer in prose", !(out.finalSections.ai_suggestion ?? "").includes("ABC Career Consultancy"));
  check("prose replaced with safe fallback", out.finalSections.ai_suggestion === SAFE_FALLBACK_TEXT);
  check("issue names the invented provider", out.issues.some((i) => i.includes("ABC Career Consultancy")), JSON.stringify(out.issues));
}
{
  // Same, with the soft check UNAVAILABLE — the exact hole: previously approved.
  const draft: ResponseSections = { ai_suggestion: "Consider contacting Bright Futures Placements to speed this up." };
  const out = await runVerificationAgent(
    { query: "how do I move into analytics?", plan: plan(["ai_suggestion"]), draftSections: draft, careerData: noAgencies },
    { softCheck: softUnavailable }
  );
  check("caught with soft check unavailable", out.approved === false);
  check("provider removed without the soft check", !(out.finalSections.ai_suggestion ?? "").includes("Bright Futures Placements"));
}
{
  // Prose is scanned in every free-text section, not just ai_suggestion.
  const draft: ResponseSections = { ai_suggestion: "Learn SQL.", next_steps: ["Call TalentEdge Consulting this week"] };
  const out = await runVerificationAgent(
    { query: "how do I move into analytics?", plan: plan(["ai_suggestion", "next_steps"]), draftSections: draft, careerData: noAgencies },
    { softCheck: softOk }
  );
  check("provider in next_steps caught", out.approved === false, JSON.stringify(out.issues));
  check("next_steps removed", out.finalSections.next_steps === undefined);
}
{
  const draft: ResponseSections = { ai_suggestion: "Try ABC Career Consultancy." };
  const blank: CareerDataAgentOutput = {
    ...careerData,
    agencies: [{ name: "   ", location: null, services: null, website: null, source: null }],
  };
  const out = await runVerificationAgent(
    { query: "how do I move into analytics?", plan: plan(["ai_suggestion"]), draftSections: draft, careerData: blank },
    { softCheck: softOk }
  );
  check("blank verified name does not allowlist everything", out.approved === false, JSON.stringify(out.issues));
}

console.log("\n== verified / generic provider mentions are NOT flagged ==");
{
  // Naming an agency that IS a verified record is grounded — it must survive.
  const draft = cleanDraft();
  draft.ai_suggestion = "Acme Careers offers counselling in Delhi.";
  const out = await runVerificationAgent(input(ALL, draft), { softCheck: softOk });
  check("verified provider kept", out.approved === true, JSON.stringify(out.issues));
  check("prose untouched", out.finalSections.ai_suggestion === "Acme Careers offers counselling in Delhi.");
}
{
  // Generic advice is the planner's call to gate, not an invented record.
  const draft: ResponseSections = {
    ai_suggestion: "Career Counsellors can help, and Top Placement Agencies exist in most cities.",
  };
  const out = await runVerificationAgent(
    { query: "how do I move into analytics?", plan: plan(["ai_suggestion"]), draftSections: draft, careerData: noAgencies },
    { softCheck: softOk }
  );
  check("generic phrasing not flagged as a name", out.approved === true, JSON.stringify(out.issues));
}
{
  // A verified long name still covers prose that shortens it.
  const longName: CareerDataAgentOutput = {
    ...careerData,
    agencies: [{ name: "Pune Career Consultancy Pvt Ltd", location: "Pune", services: "counselling", website: null, source: null }],
  };
  const draft: ResponseSections = { ai_suggestion: "Pune Career Consultancy can help." };
  const out = await runVerificationAgent(
    { query: "suggest a counsellor", plan: plan(["ai_suggestion"]), draftSections: draft, careerData: longName },
    { softCheck: softOk }
  );
  check("shortened verified name allowed", out.approved === true, JSON.stringify(out.issues));
}

// --- External sourced results as grounding (allow-listed in the hard check) ------
// A provider our OWN web retrieval surfaced is verified, not invented — prose may
// name it. A provider backed by NO source (agency or external) is still stripped.
const withExternal: CareerDataAgentOutput = {
  ...careerData,
  agencies: [], // isolate external allow-listing from the agency allowlist
  roadmaps: [
    { title: "Brightpath Consulting career guide", url: "https://brightpath.com/guide", source: "brightpath.com", snippet: "structured paths", publishedDate: null, score: null },
  ],
  marketSignals: [],
  industryArticles: [],
};

console.log("\n== externalProviderLabels derivation ==");
{
  const labels = externalProviderLabels(withExternal);
  check("includes the source host", labels.includes("brightpath.com"), JSON.stringify(labels));
  check("includes the host leading label (for substring match)", labels.includes("brightpath"), JSON.stringify(labels));
  check("includes the title", labels.includes("Brightpath Consulting career guide"), JSON.stringify(labels));
  check("no external results -> no labels", externalProviderLabels({ ...careerData, roadmaps: [], marketSignals: [], industryArticles: [] }).length === 0);
}

console.log("\n== external-sourced provider named in prose -> NOT flagged (grounded) ==");
{
  const draft: ResponseSections = { ai_suggestion: "For a structured path, see Brightpath Consulting's roadmap." };
  const out = await runVerificationAgent(
    { query: "how do I move into analytics?", plan: plan(["ai_suggestion"]), draftSections: draft, careerData: withExternal },
    { softCheck: softOk }
  );
  check("external-sourced provider kept (approved)", out.approved === true, JSON.stringify(out.issues));
  check("prose untouched", (out.finalSections.ai_suggestion ?? "").includes("Brightpath Consulting"));
}
{
  // A provider backed by NO source (not an agency, not an external result) is still invented.
  const draft: ResponseSections = { ai_suggestion: "You could also contact Ghostfirm Consulting for help." };
  const out = await runVerificationAgent(
    { query: "how do I move into analytics?", plan: plan(["ai_suggestion"]), draftSections: draft, careerData: withExternal },
    { softCheck: softOk }
  );
  check("provider backed by no source still flagged", out.approved === false, JSON.stringify(out.issues));
  check("issue names the invented provider", out.issues.some((i) => i.includes("Ghostfirm Consulting")), JSON.stringify(out.issues));
  check("invented prose replaced with safe fallback", out.finalSections.ai_suggestion === SAFE_FALLBACK_TEXT);
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
