// Company / entity-discovery tests. Fully deterministic — no LLM, no DB, no network.
// Covers the two halves of the feature:
//   A. ROUTING — a pure entity-discovery query opens the Hiring Companies lane and
//      SUPPRESSES Market Signals / Industry Articles, unless it also asks for trends
//      or analysis (then they return as supporting context).
//   B. EXTRACTION GROUNDING — coerceHiringCompanies() only ever emits companies it can
//      tie back to a retrieved source; it drops invented sources and guessed domains.
// Run:  npx tsx tests/agent-hiring-companies.test.mts
import "dotenv/config";
import {
  companyDiscoveryGate,
  marketAnalysisRequested,
  marketSignalGate,
  industryArticleGate,
  liveBusinessGate,
} from "../src/lib/agent/schema";
import { coerceHiringCompanies } from "../src/lib/agent/agents/hiringCompanies";
import type { ExternalResult } from "../src/lib/agent/agents/contracts";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`); }
}

console.log("\n== A. entity-discovery queries suppress Market Signals / Industry Articles ==");
{
  // The queries the task names: pure company/entity discovery. Each must (a) fire the
  // hiring lane and (b) NOT open the market/industry lanes.
  const DISCOVERY = [
    "Find the latest AI consulting firms hiring in Germany",
    "Top cloud consulting companies in Canada",
    "Companies hiring DevOps engineers in Berlin",
    "Best AI startups in London",
    "Who is currently hiring AI engineers in Germany?",
  ];
  for (const q of DISCOVERY) {
    check(`[${q.slice(0, 34)}…] liveBusinessGate fires`, liveBusinessGate(q) === true);
    check(`[${q.slice(0, 34)}…] treated as company discovery`, companyDiscoveryGate(q) === true);
    check(`[${q.slice(0, 34)}…] Market Signals suppressed`, marketSignalGate(q) === false, `market gate stayed open`);
    check(`[${q.slice(0, 34)}…] Industry Articles suppressed`, industryArticleGate(q) === false, `article gate stayed open`);
  }
}

console.log("\n== A. explicit trends/analysis re-open the supporting lanes ==");
{
  // When the SAME kind of query also asks for trends/analysis, the lanes come back as
  // supporting context — companyDiscoveryGate is false, so the suppression lifts.
  const WITH_ANALYSIS = [
    "Companies hiring DevOps engineers in Berlin and the salary trends",
    "Top AI firms hiring in London — also the market outlook",
    "Latest consulting firms hiring in Canada with industry analysis",
  ];
  for (const q of WITH_ANALYSIS) {
    check(`[${q.slice(0, 34)}…] analysis explicitly requested`, marketAnalysisRequested(q) === true);
    check(`[${q.slice(0, 34)}…] NOT pure discovery`, companyDiscoveryGate(q) === false);
    check(`[${q.slice(0, 34)}…] Market Signals re-open`, marketSignalGate(q) === true);
  }
}

console.log("\n== A. non-discovery market queries are unaffected ==");
{
  // A plain market question is not a live-business query, so the suppression never
  // applies and Market Signals opens exactly as before.
  const q = "What is the job market outlook for backend developers?";
  check("market outlook query is not discovery", companyDiscoveryGate(q) === false);
  check("market outlook query still opens Market Signals", marketSignalGate(q) === true);
  const salary = "What is the average salary for cyber security jobs in India?";
  check("salary query still opens Market Signals", marketSignalGate(salary) === true);
  check("salary query still opens Industry Articles", industryArticleGate(salary) === true);
}

console.log("\n== B. extraction grounding: only sourced companies survive ==");
{
  const results: ExternalResult[] = [
    { title: "Top AI firms hiring in Berlin", url: "https://builtin.example/berlin-ai", source: "builtin.example", snippet: "Acme AI is hiring DevOps engineers in Berlin.", publishedDate: null, score: 0.9 },
    { title: "Careers — Globex", url: "https://globex.example/careers", source: "globex.example", snippet: "Globex is growing its cloud team.", publishedDate: null, score: 0.8 },
  ];

  const raw = {
    companies: [
      // Valid: sourceUrl is a retrieved url; website host is retrieved.
      { name: "Acme AI", whyMatched: "listed as hiring DevOps in Berlin", roles: ["DevOps Engineer", "DevOps Engineer", " "], location: "Berlin", website: "https://builtin.example/berlin-ai", sourceUrl: "https://builtin.example/berlin-ai" },
      // Invented source url — must be dropped entirely.
      { name: "Ghost Corp", whyMatched: "made up", roles: [], location: null, website: null, sourceUrl: "https://not-retrieved.example/x" },
      // Guessed company domain — company kept, but website nulled.
      { name: "Globex", whyMatched: "growing cloud team", roles: [], location: null, website: "https://globex-guessed-domain.example", sourceUrl: "https://globex.example/careers" },
      // No name — dropped.
      { name: "  ", sourceUrl: "https://globex.example/careers" },
    ],
  };

  const out = coerceHiringCompanies(raw, results);
  check("drops company with an unsourced sourceUrl", !out.some((c) => c.name === "Ghost Corp"), JSON.stringify(out.map((c) => c.name)));
  check("drops company with a blank name", !out.some((c) => c.name.trim() === ""));
  check("keeps the two sourced companies", out.length === 2, JSON.stringify(out.map((c) => c.name)));

  const acme = out.find((c) => c.name === "Acme AI");
  check("dedupes and trims roles", acme?.roles.length === 1 && acme.roles[0] === "DevOps Engineer", JSON.stringify(acme?.roles));
  check("keeps a website whose host was retrieved", acme?.website === "https://builtin.example/berlin-ai");
  check("sets sourceName to the source host", acme?.sourceName === "builtin.example", acme?.sourceName);

  const globex = out.find((c) => c.name === "Globex");
  check("nulls a guessed company domain", globex?.website === null, String(globex?.website));
  check("still keeps the company with a valid source", globex?.sourceUrl === "https://globex.example/careers");
}

console.log("\n== B. empty / malformed extraction input -> [] ==");
{
  const results: ExternalResult[] = [
    { title: "x", url: "https://x.example/a", source: "x.example", snippet: "", publishedDate: null, score: null },
  ];
  check("no companies key -> []", coerceHiringCompanies({}, results).length === 0);
  check("non-object -> []", coerceHiringCompanies("nope", results).length === 0);
  check("null -> []", coerceHiringCompanies(null, results).length === 0);
  check("empty results with valid-looking company -> [] (nothing to source against)",
    coerceHiringCompanies({ companies: [{ name: "A", sourceUrl: "https://x.example/a" }] }, []).length === 0);
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
