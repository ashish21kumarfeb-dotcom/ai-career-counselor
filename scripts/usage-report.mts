// usage:report — read the token ledger and print the distribution.
//
// This script IS the deliverable of the measurement phase. The point of
// recording usage before building a budget allocator is that caps chosen without
// a measured distribution are guesses enforced as policy: too tight and they
// silently truncate good context, too loose and they never fire. So the numbers
// have to be readable before anything is built on top of them.
//
// It reports PERCENTILES, not just averages, because the average is the one
// statistic that cannot tell you where to put a cap. A mean prompt of 3k with a
// p95 of 14k is a completely different system from a mean of 3k with a p95 of
// 3.2k — the first has a tail that will hit the context limit and the second
// does not — and both look identical if you only print the mean.
//
// Run: npm run usage:report            (all recorded runs)
//      npm run usage:report -- 7       (last 7 days)
import "dotenv/config";
import { gte } from "drizzle-orm";
import { db } from "../src/db";
import { llmUsage } from "../src/db/schema";

const days = Number(process.argv[2]);
const since = Number.isFinite(days) && days > 0
  ? new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  : null;

const rows = await db
  .select()
  .from(llmUsage)
  .where(since ? gte(llmUsage.createdAt, since) : undefined);

if (rows.length === 0) {
  console.log(
    since
      ? `No LLM calls recorded in the last ${days} day(s).`
      : "No LLM calls recorded yet. Run some chats first, then re-run this."
  );
  process.exit(0);
}

// Nearest-rank percentile. On the small samples this table will hold early on,
// interpolation would invent precision the data does not have.
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    mean: Math.round(sum / sorted.length),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

console.log(
  `\nLLM usage — ${rows.length} calls${since ? ` since ${since.toISOString().slice(0, 10)}` : " (all time)"}\n`
);

// --- Per call site ------------------------------------------------------------
const bySite = new Map<string, typeof rows>();
for (const row of rows) {
  const list = bySite.get(row.callSite) ?? [];
  list.push(row);
  bySite.set(row.callSite, list);
}

console.log("PROMPT TOKENS BY CALL SITE");
console.log(
  `  ${"call site".padEnd(20)}${pad("n", 6)}${pad("mean", 9)}${pad("p50", 9)}${pad("p95", 9)}${pad("max", 9)}${pad("fail", 6)}`
);
const sites = [...bySite.entries()].sort(
  (a, b) => stats(b[1].map((r) => r.promptTokens)).p95 - stats(a[1].map((r) => r.promptTokens)).p95
);
for (const [site, siteRows] of sites) {
  const s = stats(siteRows.map((r) => r.promptTokens));
  const failures = siteRows.filter((r) => r.failed).length;
  console.log(
    `  ${site.padEnd(20)}${pad(s.n, 6)}${pad(s.mean, 9)}${pad(s.p50, 9)}${pad(s.p95, 9)}${pad(s.max, 9)}${pad(failures, 6)}`
  );
}

// --- Per run ------------------------------------------------------------------
// The number an allocator actually has to budget against: what one user turn
// costs end to end, not what any single call costs. Rows with no run id (resume
// memory extraction) are excluded rather than counted as one-call runs, which
// would drag the distribution down and understate a real turn.
const byRun = new Map<string, number>();
const byRunCalls = new Map<string, number>();
for (const row of rows) {
  if (!row.runId) continue;
  byRun.set(row.runId, (byRun.get(row.runId) ?? 0) + row.totalTokens);
  byRunCalls.set(row.runId, (byRunCalls.get(row.runId) ?? 0) + 1);
}

if (byRun.size > 0) {
  const runTotals = stats([...byRun.values()]);
  const runCalls = stats([...byRunCalls.values()]);
  console.log(`\nPER RUN (${byRun.size} runs)`);
  console.log(
    `  total tokens      mean ${runTotals.mean}   p50 ${runTotals.p50}   p95 ${runTotals.p95}   max ${runTotals.max}`
  );
  console.log(
    `  calls per run     mean ${runCalls.mean}   p50 ${runCalls.p50}   p95 ${runCalls.p95}   max ${runCalls.max}`
  );
} else {
  console.log("\nPER RUN: no run-scoped calls recorded yet.");
}

// --- What this means for a cap -------------------------------------------------
// Stated as an observation, not a recommendation. The threshold to compare
// against is the model's context window, which is a property of the deployed
// model and not something this table knows.
const worstPrompt = Math.max(...rows.map((r) => r.promptTokens));
console.log(
  `\nLargest single prompt observed: ${worstPrompt} tokens ` +
    `(at "${rows.find((r) => r.promptTokens === worstPrompt)?.callSite}").`
);
console.log(
  "Compare against the deployed model's context window before choosing any cap.\n"
);

process.exit(0);
