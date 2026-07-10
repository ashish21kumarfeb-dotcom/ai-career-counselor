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

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
