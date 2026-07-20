// Market-data retrieval strategy: does a question that needs a CURRENT FACT
// actually trigger external search, and does the answer stay evidence-bound?
//
// Three parts, all deterministic (no LLM, no DB, no network):
//   A) factualDataGate + the external gates — a factual-data question opens the
//      external lanes, across professions, and an advice question still does not.
//   B) the planner's derived ExecutionPlan marks those tools allowed.
//   C) the Recommendation Agent's evidence posture and the prompt clause each
//      posture produces (evidence-first vs. no-verified-data).
// Run: npm run test:market-evidence
import "dotenv/config";
// The external gates are ANDed with the master kill switch when tools are derived,
// so Part B asserts the plan for a run where external search is ON. Set before the
// modules are imported, since externalSearchEnabled() is read at call time.
process.env.EXTERNAL_SEARCH_ENABLED = "true";

import {
  factualDataGate,
  marketSignalGate,
  industryArticleGate,
  careerRoadmapGate,
} from "../src/lib/agent/schema";
import { finalizeExecutionPlan } from "../src/lib/agent/plan/finalize";
import {
  evidencePosture,
  evidenceDirective,
  hasExternalEvidence,
} from "../src/lib/agent/agents/recommendation";
import type { CareerDataAgentOutput, ExternalResult } from "../src/lib/agent/agents/contracts";
import type { PlannerProposal } from "../src/lib/agent/plan/types";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ============ A. Gates ============
console.log("\n== A. Unit: factual-data questions open the external lanes ==");
{
  // Deliberately spread across professions and phrasings. Every one of these needs
  // a current fact; none of them can be answered from model weights.
  const factual = [
    "What is the average salary of a registered nurse in Delhi?",
    "How much does a welder earn in Germany?",
    "What CTC can I expect as a chartered accountant with 3 years experience?",
    "Are there many job openings for civil engineers right now?",
    "What is the employment outlook for commercial pilots?",
    "How many vacancies are there for primary school teachers in Kerala?",
    "What is the attrition rate in the hospitality industry?",
    "typical hourly rate for a freelance graphic designer",
    "What does a physiotherapist make in the UK?",
    "median pay for HVAC technicians",
    "unemployment statistics for fresh law graduates",
    "What percentage of pharmacy graduates get placed?",
  ];
  for (const q of factual) {
    check(`factualDataGate opens for: "${q.slice(0, 46)}…"`, factualDataGate(q), q);
    check(`  -> market lane allowed`, marketSignalGate(q), q);
    check(`  -> industry lane allowed`, industryArticleGate(q), q);
  }
}

console.log("\n== A2. Unit: pure advice questions do NOT open the factual lane ==");
{
  const advice = [
    "I feel stuck in my job, what should I think about?",
    "Should I tell my manager I want to move teams?",
    "Suggest a counsellor in Delhi",
    "How do I stay motivated while preparing?",
  ];
  for (const q of advice) {
    check(`factualDataGate stays shut for: "${q.slice(0, 40)}…"`, !factualDataGate(q), q);
  }
  // The pure agency lookup must still earn no external lane at all — the existing
  // invariant that these gates were built to protect.
  const agencyOnly = "Suggest a counsellor in Delhi";
  check(
    "pure agency lookup earns no external lane",
    !marketSignalGate(agencyOnly) && !industryArticleGate(agencyOnly) && !careerRoadmapGate(agencyOnly),
    agencyOnly
  );
}

// ============ B. Plan derivation ============
console.log("\n== B. Unit: the ExecutionPlan marks external search allowed ==");
{
  const proposal: PlannerProposal = {
    goal: "Answer a pay question.",
    requiredContext: ["profile"],
    agents: ["profile", "career_data", "recommendation", "verification"],
    tools: [],
    expectedSections: ["ai_suggestion"],
    reasoning: "test",
  };
  const query = "What is the average salary of a registered nurse in Delhi?";
  const { executionPlan } = finalizeExecutionPlan(proposal, query, false);
  const allowed = (name: string) =>
    executionPlan.tools.find((t) => t.tool === name)?.allowed === true;

  check("searchMarketSignals is planned as allowed", allowed("searchMarketSignals"),
    JSON.stringify(executionPlan.tools));
  check("searchIndustryArticles is planned as allowed", allowed("searchIndustryArticles"),
    JSON.stringify(executionPlan.tools));
  check("searchDocuments still always allowed", allowed("searchDocuments"));
  // Governance unchanged: a pay question names no provider, so agencies stay vetoed.
  check("searchAgencies still vetoed (no provider named)", !allowed("searchAgencies"));

  // A non-tech, non-salary factual question reaches the same verdict — the gate is
  // about the SHAPE of the fact, not the domain.
  const { executionPlan: plan2 } = finalizeExecutionPlan(
    proposal,
    "How many openings are there for diesel mechanics in Australia?",
    false
  );
  check(
    "same verdict for a trades question (domain-agnostic)",
    plan2.tools.find((t) => t.tool === "searchMarketSignals")?.allowed === true
  );
}

// ============ C. Recommendation evidence posture ============
console.log("\n== C. Unit: evidence posture and the prompt clause it produces ==");
{
  const emptyCareerData: CareerDataAgentOutput = {
    ragDocs: [],
    resources: [],
    courses: [],
    agencies: [],
    sourcesUsed: [],
    missingDataNotes: [],
    toolCalls: [],
  };
  const signal: ExternalResult = {
    title: "Occupational Employment and Wages, Registered Nurses",
    url: "https://www.bls.gov/oes/nurses.htm",
    source: "bls.gov",
    snippet: "The median annual wage for registered nurses was reported at ...",
    publishedDate: null,
    score: 0.9,
  };
  const withEvidence: CareerDataAgentOutput = { ...emptyCareerData, marketSignals: [signal] };
  const factualQuery = "What is the average salary of a registered nurse in Delhi?";
  const adviceQuery = "I feel stuck in my job, what should I think about?";

  check("hasExternalEvidence false when no lane returned", !hasExternalEvidence(emptyCareerData));
  check("hasExternalEvidence true for a market signal", hasExternalEvidence(withEvidence));
  check(
    "DB resources alone are not evidence for a factual claim",
    !hasExternalEvidence({
      ...emptyCareerData,
      resources: [{ id: "r1", title: "SQL course", url: "https://x.io/sql", type: "career_data" } as never],
    })
  );

  const p1 = evidencePosture(factualQuery, withEvidence);
  check("factual + evidence -> required && available", p1.required && p1.available);
  const d1 = evidenceDirective(p1);
  check("evidence-first clause selected", d1.includes("EVIDENCE-FIRST"), d1.slice(0, 80));
  check("evidence-first demands attribution", /attribut/i.test(d1));
  check(
    "evidence-first rules out model knowledge",
    /background knowledge is NOT an admissible source/i.test(d1)
  );

  const p2 = evidencePosture(factualQuery, emptyCareerData);
  check("factual + nothing retrieved -> required && !available", p2.required && !p2.available);
  const d2 = evidenceDirective(p2);
  check("no-verified-data clause selected", d2.includes("NO VERIFIED DATA"), d2.slice(0, 80));
  check("no-verified-data forbids any figure", /Do NOT state, estimate, approximate/i.test(d2));
  check("no-verified-data forbids generic padding", /pad the gap with generic career advice/i.test(d2));
  check(
    "no-verified-data explicitly overrides the advise-anyway rule",
    /OVERRIDES the general guidance/i.test(d2)
  );

  // RAG alone is enough to count as available: a curated doc IS retrieved evidence.
  const p3 = evidencePosture(factualQuery, {
    ...emptyCareerData,
    ragDocs: [{ id: "d1", content: "Nursing pay bands...", type: "career_data", sourceUrl: null } as never],
  });
  check("RAG doc counts as available evidence", p3.required && p3.available);

  // An advice question keeps the ORIGINAL numbers rule, including its permission to
  // advise without a figure — the fix must not make ordinary guidance refuse.
  const p4 = evidencePosture(adviceQuery, emptyCareerData);
  check("advice question -> not required", !p4.required);
  const d4 = evidenceDirective(p4);
  check("advice question keeps the Numbers rule", d4.startsWith("Numbers rule:"), d4.slice(0, 60));
  check(
    "advice question still allowed to advise without a figure",
    /do NOT refuse to advise just because a figure is unavailable/i.test(d4)
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
