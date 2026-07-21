// Factual-grounding policy tests. Fully deterministic — the pure module needs no
// LLM at all, and the integration cases inject the soft check.
//
// The suite is organized around the two failure modes that matter in opposite
// directions: FALSE NEGATIVES (a fabricated figure ships) and FALSE POSITIVES (a
// good answer is rejected). The second half is the larger half on purpose — a
// grounding gate that rejects useful advice is worse than no gate.
// Run: npm run test:grounding
//
// Loads dotenv despite never touching the database. This suite asserts nothing
// about persistence, but it imports verification.ts, which imports createCompletion
// from ai/usage, which imports the db client — and that client THROWS at module
// load when DATABASE_URL is unset, before a single test runs. So the requirement is
// an artifact of the import graph, not of what is being tested: usage accounting
// put a db import behind every LLM call site. Keeping the env load here is cheaper
// than making the test mock a module it does not exercise.
import "dotenv/config";
import {
  checkFactualGrounding,
  extractValues,
  isHedged,
  collectEvidenceText,
  UNSUPPORTED_CLAIM_ISSUE,
} from "../src/lib/agent/agents/grounding";
import { runVerificationAgent, sanitizeDraft } from "../src/lib/agent/agents/verification";
import type { AgentPlan, ResponseSections, SectionName } from "../src/lib/agent/schema";
import type {
  CareerDataAgentOutput,
  ProfileAgentOutput,
  VerificationAgentInput,
} from "../src/lib/agent/agents/contracts";
import type { SoftCheckResult as Soft } from "../src/lib/agent/agents/verification";

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

const softOk: () => Promise<Soft> = async () => ({ available: true, grounded: true, safe: true, notes: "ok" });
const softUngrounded: () => Promise<Soft> = async () => ({ available: true, grounded: false, safe: true, notes: "unsupported figures" });
const softUnavailable: () => Promise<Soft> = async () => ({ available: false, grounded: false, safe: false, notes: "LLM error" });

// Evidence fixture: one RAG doc and one external result, both carrying figures.
const careerData: CareerDataAgentOutput = {
  ragDocs: [{ id: "d1", type: "career_data", content: "Analyst salaries in India range from 6 to 12 LPA.", sourceUrl: "https://k/1" }],
  resources: [],
  courses: [],
  agencies: [],
  marketSignals: [
    {
      title: "Analytics hiring report",
      url: "https://m/1",
      source: "example.com",
      snippet: "Demand for data roles grew 22% year on year; firms added 40,000 analysts.",
      publishedDate: null,
      score: null,
    },
  ],
  sourcesUsed: [],
  missingDataNotes: [],
  toolCalls: [],
};

// Same shape with no evidence at all — the "evidence unavailable" branch.
const noEvidence: CareerDataAgentOutput = {
  ...careerData,
  ragDocs: [],
  marketSignals: [],
};

const profile: ProfileAgentOutput = {
  profileSummary: "Working professional with 3 years of experience in support.",
  memorySummary: "Targeting a 15 LPA package.",
  userContext: {
    stage: "working_professional",
    currentRole: "Support Engineer",
    skills: ["Excel"],
    interests: ["analytics"],
    careerGoal: "Data Analyst",
    location: "Pune",
  },
  importantConstraints: [],
};

const QUERY = "how do I move into data analytics?";
// `null` means "no profile", explicitly — an `undefined` argument would fall back to
// the default parameter and silently keep the profile in the evidence corpus, which
// is precisely what the C2 cases are trying to remove.
function ev(cd: CareerDataAgentOutput = careerData, p: ProfileAgentOutput | null = profile) {
  return { careerData: cd, query: QUERY, profile: p ?? undefined };
}
function plan(sections: SectionName[]): AgentPlan {
  return { sections, reasoning: "test" };
}
function input(sections: SectionName[], draftSections: ResponseSections, cd = careerData): VerificationAgentInput {
  return { query: QUERY, plan: plan(sections), draftSections, careerData: cd, profile };
}

// ============ A. Numeric parsing (the part everything else rests on) ============
console.log("\n== A. value extraction + normalization ==");
{
  check("LPA scales to absolute", extractValues("12 LPA")[0]?.low === 1_200_000);
  check("lakh is the same magnitude as LPA", extractValues("12 lakh")[0]?.low === 1_200_000);
  check("indian grouping parses", extractValues("₹12,00,000")[0]?.low === 1_200_000);
  check("crore scales", extractValues("2 crore")[0]?.low === 2e7);

  const range = extractValues("18-24 LPA")[0];
  check("range keeps both endpoints", range?.low === 1_800_000 && range?.high === 2_400_000, JSON.stringify(range));
  const enDash = extractValues("18–24 LPA")[0];
  check("en-dash range parses", enDash?.low === 1_800_000 && enDash?.high === 2_400_000);
  const wordy = extractValues("6 to 12 LPA")[0];
  check('"to" range parses', wordy?.low === 600_000 && wordy?.high === 1_200_000);

  check("percent is its own kind", extractValues("grew 22%")[0]?.kind === "percent");
  check("years normalize to months", extractValues("2 years")[0]?.low === 24);
  check("months stay months", extractValues("6 months")[0]?.low === 6);
  check("duration beats the single-letter money scale", extractValues("3 months")[0]?.kind === "duration");
  check("ordinal is a rank", extractValues("the 3rd fastest-growing role")[0]?.kind === "rank");
  check("large bare number is a statistic", extractValues("hired 40,000 freshers")[0]?.kind === "count");
}

console.log("\n== A2. structural numerals are NOT claims ==");
{
  check("small bare count ignored", extractValues("build 3 portfolio projects").length === 0, JSON.stringify(extractValues("build 3 portfolio projects")));
  check("bare year ignored", extractValues("starting in 2026").length === 0);
  check("step index ignored", extractValues("2 rounds of interviews").length === 0);
}

console.log("\n== A3. hedge detection ==");
{
  check("explicit estimate is hedged", isHedged("Salaries typically vary; roughly 12 LPA is common."));
  check("no-verified-data phrasing is hedged", isHedged("I don't have verified figures for your market."));
  check("plain assertion is not hedged", !isHedged("The median salary is 24 LPA."));
}

// ============ B. False NEGATIVES — fabrication must be caught ============
console.log("\n== B. unsupported figures are flagged ==");
{
  const r = checkFactualGrounding({ ai_suggestion: "Analysts in Pune earn 45 LPA on average." }, ev());
  check("out-of-evidence salary flagged", r.unsupported.length === 1, JSON.stringify(r.claims));
  check("the offending figure is named", r.unsupported[0]?.values[0]?.raw.includes("45"), JSON.stringify(r.unsupported));
}
{
  const r = checkFactualGrounding({ ai_suggestion: "Demand grew 90% last year." }, ev());
  check("out-of-evidence percentage flagged", r.unsupported.length === 1);
}
{
  const r = checkFactualGrounding({ next_steps: ["Apply now — firms are hiring 500,000 analysts."] }, ev());
  check("out-of-evidence hiring count flagged", r.unsupported.length === 1);
  check("issue attributes the section", r.unsupported[0]?.section === "next_steps");
}
{
  const r = checkFactualGrounding({ ai_suggestion: "Analytics is the 2nd fastest-growing field." }, ev());
  check("unbacked ranking flagged", r.unsupported.length === 1);
}
{
  // The kind system must not let a coincidence ground a claim: evidence has 22
  // PERCENT, the draft asserts 22 LAKH.
  const r = checkFactualGrounding({ ai_suggestion: "You should expect 22 LPA." }, ev());
  check("matching digit of a different kind does NOT ground", r.unsupported.length === 1, JSON.stringify(r.claims));
}

console.log("\n== B2. no evidence at all -> numbers must be hedged, guidance still flows ==");
{
  const r = checkFactualGrounding({ ai_suggestion: "Analysts earn 18 LPA in your city." }, ev(noEvidence, null));
  check("bare figure with zero evidence is flagged", r.unsupported.length === 1);
}
{
  const r = checkFactualGrounding(
    { ai_suggestion: "Compensation varies widely by city and stack, and I don't have verified figures — plan on roughly 2 years to switch." },
    ev(noEvidence, null)
  );
  check("hedged figure with zero evidence is allowed", r.unsupported.length === 0, JSON.stringify(r.claims));
  check("hedged claim is recorded, not silent", r.claims.some((c) => c.verdict === "hedged"));
}
{
  const r = checkFactualGrounding(
    { ai_suggestion: "Start with SQL, then build two dashboards and target mid-size product firms." },
    ev(noEvidence, null)
  );
  check("qualitative guidance with no evidence is untouched", r.claims.length === 0, JSON.stringify(r.claims));
}

// ============ C. False POSITIVES — good answers must survive ============
console.log("\n== C. figures that ARE supported ==");
{
  const r = checkFactualGrounding({ ai_suggestion: "Analyst salaries range from 6 to 12 LPA." }, ev());
  check("verbatim evidence range is grounded", r.unsupported.length === 0, JSON.stringify(r.claims));
}
{
  // RANGE AWARENESS, not exact equality: the draft narrows the evidence's 6-12 LPA.
  const r = checkFactualGrounding({ ai_suggestion: "Expect somewhere in the 8-10 LPA band." }, ev());
  check("narrowing an evidence range is grounded", r.unsupported.length === 0, JSON.stringify(r.claims));
}
{
  const r = checkFactualGrounding({ ai_suggestion: "Around 12.5 LPA is realistic at the top of that band." }, ev());
  check("rounding within tolerance is grounded", r.unsupported.length === 0, JSON.stringify(r.claims));
}
{
  const r = checkFactualGrounding({ ai_suggestion: "Salaries reach ₹12,00,000 for strong candidates." }, ev());
  check("different notation of the same magnitude is grounded", r.unsupported.length === 0, JSON.stringify(r.claims));
}
{
  const r = checkFactualGrounding({ ai_suggestion: "Demand grew 22% year on year." }, ev());
  check("evidence percentage is grounded", r.unsupported.length === 0);
}
{
  const r = checkFactualGrounding({ ai_suggestion: "Tolerance has limits: expect 60 LPA." }, ev());
  check("tolerance does NOT bridge an order of magnitude", r.unsupported.length === 1);
}

console.log("\n== C2. the user is evidence ==");
{
  const r = checkFactualGrounding({ ai_suggestion: "With your 3 years of experience, aim for the 15 LPA target you mentioned." }, ev());
  check("figures from the user's own profile/memory are grounded", r.unsupported.length === 0, JSON.stringify(r.claims));
}
{
  const r = checkFactualGrounding({ ai_suggestion: "With your 3 years of experience, aim for the 15 LPA target." }, ev(careerData, null));
  check("without the profile the SAME sentence is flagged (profile really is the source)", r.unsupported.length === 1);
  check("evidence text includes profile lines when supplied", collectEvidenceText(ev()).some((t) => t.includes("3 years")));
}

console.log("\n== C3. roadmap structure and suggested framing ==");
{
  const sections: ResponseSections = {
    roadmap: { items: ["1. Learn SQL in 3 months", "Month 4-6: build 2 dashboards"], suggested: true },
  };
  const r = checkFactualGrounding(sections, ev(noEvidence, null));
  check("timelines inside a suggested roadmap are not factual claims", r.unsupported.length === 0, JSON.stringify(r.claims));
}
{
  const sections: ResponseSections = {
    roadmap: { items: ["Step 3: negotiate for 40 LPA"], suggested: true },
  };
  const r = checkFactualGrounding(sections, ev(noEvidence, null));
  check("but a salary inside a suggested roadmap IS still enforced", r.unsupported.length === 1, JSON.stringify(r.claims));
}
{
  const sections: ResponseSections = { roadmap: { items: ["Learn SQL over 6 months"], suggested: false } };
  const r = checkFactualGrounding(sections, ev(noEvidence, null));
  check("timeline in a NON-suggested roadmap is enforced", r.unsupported.length === 1);
}

// ============ D. Integration through the verifier ============
console.log("\n== D. approval decision ==");
{
  const out = await runVerificationAgent(
    input(["ai_suggestion"], { ai_suggestion: "Analysts in Pune earn 45 LPA on average." }),
    { softCheck: softOk }
  );
  check("unsupported figure blocks approval", out.approved === false, JSON.stringify(out.issues));
  check("issue uses the policy prefix", out.issues.some((i) => i.startsWith(UNSUPPORTED_CLAIM_ISSUE)), JSON.stringify(out.issues));
  check("figure surfaced on the envelope", (out.unsupportedClaims ?? []).some((c) => c.includes("45")), JSON.stringify(out.unsupportedClaims));
  check("prose is NOT gutted — regeneration handles it", out.finalSections.ai_suggestion?.includes("45 LPA") === true);
  check("fix brief tells the model how to repair", out.recommendedFix?.includes("unverified estimate") === true, out.recommendedFix);
}
{
  const out = await runVerificationAgent(
    input(["ai_suggestion"], { ai_suggestion: "Analyst salaries range from 6 to 12 LPA." }),
    { softCheck: softOk }
  );
  check("supported figure approves cleanly", out.approved === true, JSON.stringify(out.issues));
  check("no issues raised", out.issues.length === 0, JSON.stringify(out.issues));
}
{
  const out = await runVerificationAgent(
    input(["ai_suggestion"], { ai_suggestion: "Focus on SQL and build two dashboards." }),
    { softCheck: softOk }
  );
  check("advice-only answer untouched by the gate", out.approved === true, JSON.stringify(out.issues));
}

console.log("\n== D2. the soft grounding verdict now participates ==");
{
  const out = await runVerificationAgent(
    input(["ai_suggestion"], { ai_suggestion: "Focus on SQL and build two dashboards." }),
    { softCheck: softUngrounded }
  );
  check("soft grounded:false blocks approval", out.approved === false, JSON.stringify(out.issues));
  check("issue explains why", out.issues.some((i) => i.includes("not grounded")), JSON.stringify(out.issues));
  check("free text is NOT replaced (that remedy is for unsafe only)", out.finalSections.ai_suggestion === "Focus on SQL and build two dashboards.");
}
{
  // The regression the naive `approved && grounded` fix would have introduced.
  const out = await runVerificationAgent(
    input(["ai_suggestion"], { ai_suggestion: "Focus on SQL and build two dashboards." }),
    { softCheck: softUnavailable }
  );
  check("unavailable soft check still does NOT block", out.approved === true, JSON.stringify(out.issues));
  check("but grounded is reported unconfirmed", out.grounded === false);
  check("prose survives an outage", out.finalSections.ai_suggestion === "Focus on SQL and build two dashboards.");
}

console.log("\n== D3. sanitizeDraft stays pure and total ==");
{
  const r = sanitizeDraft(input(["ai_suggestion"], { ai_suggestion: "Analysts earn 45 LPA." }));
  check("hard issue recorded", r.hardIssues.some((i) => i.startsWith(UNSUPPORTED_CLAIM_ISSUE)));
  check("unsupportedClaims returned", r.unsupportedClaims.length === 1, JSON.stringify(r.unsupportedClaims));
}
{
  const r = sanitizeDraft(input(["ai_suggestion"], {}));
  check("empty draft does not throw and flags nothing quantitative", r.unsupportedClaims.length === 0);
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
