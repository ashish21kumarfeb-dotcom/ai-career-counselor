// Relevance tests for the resource/course retrieval tool. Verifies that
// searchResources returns only ON-TOPIC links for a query — the fix for the bug
// where a generic word ("learn") pulled in unrelated resources. Requires
// DATABASE_URL and the seeded documents (npm run seed:documents). No LLM.
import "dotenv/config";
import { searchResources } from "../src/lib/documents/queries";

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

const has = (u: string, s: string) => u.toLowerCase().includes(s);

type Case = {
  query: string;
  relevant: (u: string) => boolean; // an on-topic link
  forbidden: (u: string) => boolean; // an off-topic link that must NOT appear
  expectAtLeastOne: (u: string) => boolean; // a specific expected link
};

const CASES: Case[] = [
  {
    query: "I want to learn Azure. What should I do?",
    relevant: (u) => has(u, "learn.microsoft.com"),
    forbidden: (u) => has(u, "roadmap.sh") || has(u, "grow.google") || has(u, "mozilla") || has(u, "freecodecamp"),
    expectAtLeastOne: (u) => has(u, "azure") || has(u, "dotnet"),
  },
  {
    query: "I want to become a data analyst.",
    relevant: (u) => has(u, "data-analyst") || has(u, "grow.google") || has(u, "data-analysis"),
    forbidden: (u) => has(u, "microsoft.com") || has(u, "mozilla") || has(u, "frontend"),
    expectAtLeastOne: (u) => has(u, "data-analyst") || has(u, "grow.google") || has(u, "data-analysis"),
  },
  {
    query: "I want to learn web development.",
    relevant: (u) => has(u, "roadmap.sh/frontend") || has(u, "mozilla"),
    forbidden: (u) => has(u, "microsoft.com") || has(u, "data-analyst") || has(u, "data-analysis") || has(u, "grow.google"),
    expectAtLeastOne: (u) => has(u, "roadmap.sh/frontend") || has(u, "mozilla"),
  },
];

console.log("\n== searchResources relevance ==");
for (const c of CASES) {
  const rows = await searchResources(c.query);
  const urls = rows.map((r) => r.sourceUrl ?? "");
  console.log(`\n[${c.query}]\n  -> ${JSON.stringify(urls)}`);
  check(`[${c.query.slice(0, 28)}…] returns at least one resource`, urls.length > 0, JSON.stringify(urls));
  check(`[${c.query.slice(0, 28)}…] every result is on-topic`, urls.every((u) => c.relevant(u)), JSON.stringify(urls));
  check(`[${c.query.slice(0, 28)}…] no off-topic result`, !urls.some((u) => c.forbidden(u)), JSON.stringify(urls));
  check(`[${c.query.slice(0, 28)}…] includes an expected link`, urls.some((u) => c.expectAtLeastOne(u)), JSON.stringify(urls));
}

// A subject the seeded corpus does not cover at all. The corpus has no
// cyber-security document, but two Azure pages list the word "security" among
// Azure's features — and relevance used to be judged only RELATIVELY (keep
// everything within 60% of the best match), which quietly assumes the best match is
// relevant. With nothing on topic, the best match was a false positive and the
// cutoff preserved it. Both queries below returned Azure Fundamentals and Azure SQL.
//
// The floor is subject COVERAGE: a document must match at least two of the query's
// specific terms (or all of them when there are fewer than two), so one incidental
// word out of a two-word subject can no longer carry a result. The right answer for
// an uncovered subject is NOTHING — the caller then says "no verified resources
// found" instead of showing links about a different field.
console.log("\n== uncovered subject returns nothing, not near-misses ==");
for (const query of [
  "What is the current market scope for cyber security jobs?",
  "Are there jobs for cyber security?",
  "Is there demand for cyber security roles?",
]) {
  const urls = (await searchResources(query)).map((r) => r.sourceUrl ?? "");
  check(
    `[${query.slice(0, 34)}…] returns no off-subject links`,
    urls.length === 0,
    JSON.stringify(urls)
  );
}

// The counterpart guarantee: the floor must not silence a covered subject. Market-
// question FRAMING ("current", "market", "scope", "salary", "demand") is now demoted
// to generic vocabulary — it is how a question is phrased, not what it is about, and
// treating it as a topic is what let framing words anchor a match. A framed question
// about a subject the corpus DOES cover must still retrieve it.
console.log("\n== framing words do not suppress a covered subject ==");
{
  const urls = (await searchResources("What is the current market scope for data analyst jobs?")).map(
    (r) => r.sourceUrl ?? ""
  );
  check("framed data-analyst query still retrieves", urls.length > 0, JSON.stringify(urls));
  check(
    "and everything it retrieves is on-subject",
    urls.every((u) => has(u, "data-analy") || has(u, "grow.google")),
    JSON.stringify(urls)
  );
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
