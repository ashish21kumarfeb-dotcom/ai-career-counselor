// Pure tests for the offline-evaluation export helpers (src/lib/eval/export.ts)
// and the committed golden fixture. No DB, no network, no Python.
// Run: npm run test:eval-export
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  flattenAnswer,
  contextsFromSources,
  toJsonl,
  type PersistedSourceRef,
} from "../src/lib/eval/export";
import { INTENTS } from "../src/lib/ai/intent";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`); }
}

console.log("\n== flattenAnswer: sectioned JSON -> prose ==");
{
  const answer = flattenAnswer(JSON.stringify({
    ai_suggestion: "Move toward automation testing.",
    roadmap: { items: ["Learn Selenium", "Build a suite"], suggested: true },
    skill_focus: ["Java", "CI"],
    next_steps: ["Take a course"],
    resources: { items: [{ title: "Testing Roadmap", type: "career_data", url: "https://x" }] },
    agencies: { items: [{ name: "Acme Careers", location: "Delhi", services: "counselling", website: null, source: "db" }] },
  }));
  check("free text leads", answer.startsWith("Move toward automation testing."));
  check("roadmap flattened", answer.includes("Roadmap: Learn Selenium; Build a suite"));
  check("skills flattened", answer.includes("Skills to focus on: Java, CI"));
  check("resources flattened", answer.includes("Testing Roadmap"));
  check("agencies flattened", answer.includes("Agencies: Acme Careers"));

  // UNCAPPED — the chat-history flattener clips at 1500 chars; evaluation must
  // judge the whole answer.
  const long = flattenAnswer(JSON.stringify({ ai_suggestion: "x".repeat(4000) }));
  check("not clipped to the chat-window cap", long.length === 4000, String(long.length));

  check("legacy plain-text rows pass through", flattenAnswer("plain old answer") === "plain old answer");
  check("null -> empty string", flattenAnswer(null) === "");
  check("empty sections -> empty string", flattenAnswer("{}") === "");
}

console.log("\n== contextsFromSources: excerpts, joins, and the honesty flag ==");
{
  const withExcerpts: PersistedSourceRef[] = [
    { id: "a", type: "rag_doc", sourceUrl: null, excerpt: "Doc text about analytics." },
    { id: "https://x", type: "external_market_signal", sourceUrl: "https://x", excerpt: "Demand grew 12%." },
  ];
  const r1 = contextsFromSources(withExcerpts);
  check("excerpt refs become contexts", r1.contexts.length === 2 && r1.contexts[0] === "Doc text about analytics.");
  check("all resolved -> complete", r1.complete === true);

  const legacy: PersistedSourceRef[] = [
    { id: "doc-1", type: "career_data", sourceUrl: null },
    { id: "agency-1", type: "agency", sourceUrl: null },
  ];
  const r2 = contextsFromSources(legacy, ({ id, type }) =>
    type === "agency" ? (id === "agency-1" ? "Acme — Delhi — counselling" : undefined) : id === "doc-1" ? "Joined doc content." : undefined
  );
  check("legacy refs resolved through the lookup", r2.contexts.length === 2 && r2.complete === true, JSON.stringify(r2));

  const r3 = contextsFromSources(legacy); // no lookup available
  check("unresolvable refs -> incomplete", r3.complete === false && r3.contexts.length === 0);

  const r4 = contextsFromSources([legacy[0], withExcerpts[0]]);
  check("partial resolution keeps what it has but stays incomplete", r4.contexts.length === 1 && r4.complete === false);

  check("no refs at all -> incomplete", contextsFromSources([]).complete === false);
  check("null jsonb -> incomplete, no throw", contextsFromSources(null).complete === false);

  const r5 = contextsFromSources([{ id: "d", type: "career_data" }], () => "y".repeat(1000));
  check("joined text is bounded like written excerpts (400)", r5.contexts[0]?.length === 400);
}

console.log("\n== toJsonl: the exchange format ==");
{
  const jsonl = toJsonl([
    { case_id: "a", query: "q", answer: "a", contexts: [], contexts_complete: false },
    { case_id: "b", query: "q2", answer: "a2", contexts: ["c"], contexts_complete: true },
  ]);
  const lines = jsonl.trim().split("\n");
  check("one JSON object per line", lines.length === 2 && lines.every((l) => !!JSON.parse(l)));
  check("trailing newline (POSIX-friendly append)", jsonl.endsWith("\n"));
  check("empty input -> empty string", toJsonl([]) === "");
}

console.log("\n== golden fixture: parseable, unique, and intent-covering ==");
{
  const raw = readFileSync(join("tests", "fixtures", "eval-golden.jsonl"), "utf8");
  const rows = raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { case_id: string; query: string; intent?: string; ground_truth?: string });
  check("~30 curated cases", rows.length >= 25, String(rows.length));
  check("every case has id + query + ground_truth", rows.every((r) => r.case_id && r.query && r.ground_truth));
  check("case ids unique", new Set(rows.map((r) => r.case_id)).size === rows.length);
  check("case ids use the golden- prefix (no FK collision with prod uuids)", rows.every((r) => r.case_id.startsWith("golden-")));
  const covered = new Set(rows.map((r) => r.intent));
  check("all 7 intents covered", INTENTS.every((i) => covered.has(i)), JSON.stringify([...covered]));
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
