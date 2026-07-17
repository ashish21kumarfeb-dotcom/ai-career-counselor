// Intent-driven search-strategy tests. Fully HERMETIC: resolveSearchStrategy is a
// pure function (no DB, no network, no LLM), so these run with nothing mocked.
// Covers:
//   A. evergreen career questions -> general corpus, across many domains
//   B. time-sensitive questions   -> news corpus (+ recency window)
//   C. precedence: a time-sensitive signal overrides an evergreen one
//   D. generic recency words ("current"/"latest"/"recent") do NOT force news
//   E. the layer is technology-agnostic (same mapping regardless of stack)
//   F. registry is extensible: a new row is honoured with no code change
// Run:  npm run test:strategy
import {
  resolveSearchStrategy,
  SEARCH_INTENTS,
  DEFAULT_INTENT,
  type SearchIntent,
} from "../src/lib/external/searchStrategy";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`); }
}
const corpus = (q: string) => resolveSearchStrategy(q).strategy.corpus;

// ============ A. Evergreen -> general, every career domain ============
console.log("\n== A. evergreen career questions -> general corpus ==");
for (const q of [
  "current hiring demand for Backend .NET Developers in 2026",
  "job outlook for Java developers",
  "is Python still in demand for data engineering",
  "salary for a DevOps engineer in India",
  "what skills does a frontend developer need",
  "best certifications for a cybersecurity analyst",
  "roadmap to become a product manager",
  "learning resources and courses for UX design",
  "state of the QA automation industry",
  "AI engineer hiring trends and technology adoption",
]) {
  check(`general :: ${q.slice(0, 46)}`, corpus(q) === "general", corpus(q));
}

// ============ B. Time-sensitive -> news (+ recency window) ============
console.log("\n== B. time-sensitive questions -> news corpus ==");
for (const [q, wantDays] of [
  ["recent layoffs at tech companies affecting data engineers", 60],
  // "hiring freeze" is a layoffs signal AND "announcements" is one too; both are
  // priority 100, so the first-declared (layoffs, days 60) wins the tie.
  ["hiring freeze announcements in fintech", 60],
  ["which startups raised a Series B in AI this year", 90],
  ["latest acquisition and merger news in cybersecurity", 90],
  ["breaking news about the Python foundation", 30],
] as const) {
  const r = resolveSearchStrategy(q);
  check(`news :: ${q.slice(0, 46)}`, r.strategy.corpus === "news", r.strategy.corpus);
  check(`news window set :: ${q.slice(0, 40)}`, r.strategy.days === wantDays, String(r.strategy.days));
}

// ============ C. Precedence: time-sensitive overrides evergreen ============
console.log("\n== C. a time-sensitive signal overrides an evergreen one ==");
check("salary + layoffs -> news", corpus("salary trends and recent layoffs for QA engineers") === "news");
check("roadmap + acquisition -> news", corpus("roadmap for engineers after the big acquisition") === "news");

// ============ D. Generic recency words do NOT force news ============
console.log("\n== D. 'current'/'latest'/'recent' alone stay evergreen ==");
check("current demand -> general", corpus("current demand for cloud engineers") === "general");
check("latest skills -> general", corpus("latest in-demand skills for data scientists") === "general");
check("recent salary -> general", corpus("recent salary ranges for product designers") === "general");

// ============ E. Technology-agnostic ============
console.log("\n== E. mapping is identical regardless of technology ==");
const stacks = ["Rust", "Go", "Kotlin", "Scala", "Swift", "PHP", "Ruby", "Elixir"];
check("every stack's demand query -> general",
  stacks.every((s) => corpus(`hiring demand and salary for ${s} developers`) === "general"));
check("every stack's layoff query -> news",
  stacks.every((s) => corpus(`recent layoffs among ${s} developers`) === "news"));

// ============ F. Unknown query falls back to the evergreen default ============
console.log("\n== F. unrecognized query -> evergreen default (never the starved news index) ==");
const unknown = resolveSearchStrategy("tell me something interesting about the universe");
check("unknown -> default intent", unknown.intent === DEFAULT_INTENT, unknown.intent);
check("unknown -> general corpus", unknown.strategy.corpus === "general");

// ============ G. Extensibility: a new row is honoured with no code change ============
console.log("\n== G. adding an intent row changes behaviour without touching resolver ==");
const before = corpus("visa sponsorship options for software engineers");
const newRow: SearchIntent = {
  name: "visa_news",
  priority: 100,
  pattern: /\bvisa sponsorship\b/,
  strategy: { corpus: "news", days: 120 },
};
SEARCH_INTENTS.push(newRow);
const after = resolveSearchStrategy("visa sponsorship options for software engineers");
check("new intent not matched before it existed", before === "general", before);
check("new intent honoured after being added", after.intent === "visa_news" && after.strategy.corpus === "news");
SEARCH_INTENTS.pop();

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
