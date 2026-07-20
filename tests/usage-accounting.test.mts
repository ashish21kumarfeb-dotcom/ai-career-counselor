// Token-ledger tests.
//
// Part A (default): the capture mechanism — ambient attribution, isolation
// between concurrent runs, survival of a throw, aggregation. Pure; no LLM.
// Part B (default): a live flush + read-back against the real llm_usage table,
// with a null user_id and a synthetic run id, cleaned up afterwards.
// Part C (opt-in): one real Groq call, to prove the provider's own token counts
// reach the ledger. Costs quota, so it is gated.
// Run: npm run test:usage
//      RUN_LIVE_USAGE=1 npm run test:usage   (adds Part C; needs GROQ_API_KEY)
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { llmUsage } from "../src/db/schema";
import {
  withUsageCapture,
  recordUsage,
  collectedUsage,
  flushUsage,
  summarizeUsage,
  createCompletion,
  type UsageRow,
} from "../src/lib/ai/usage";
import { INTENT_MODEL } from "../src/lib/ai/client";

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

function fakeCall(callSite: string, prompt: number, completion: number) {
  recordUsage({
    callSite,
    model: "test-model",
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    durationMs: 5,
    failed: false,
  });
}

console.log("\n== A. ambient attribution ==");
{
  const rows: UsageRow[] = [];
  const runId = randomUUID();
  const userId = randomUUID();
  await withUsageCapture({ runId, userId }, rows, async () => {
    fakeCall("intent", 100, 5);
    fakeCall("planner", 400, 60);
  });

  check("both calls captured", rows.length === 2, String(rows.length));
  check("run id attached without being passed to the call site", rows.every((r) => r.runId === runId));
  check("user id attached", rows.every((r) => r.userId === userId));
  check("call sites preserved", rows.map((r) => r.callSite).join(",") === "intent,planner");
}

console.log("\n== A. calls nest through the await chain ==");
{
  // The property ALS buys: a call several frames deep, in a function that knows
  // nothing about runs, still lands on the right ledger.
  const rows: UsageRow[] = [];
  const runId = randomUUID();
  const deep = async () => {
    await new Promise((r) => setTimeout(r, 1));
    fakeCall("verification", 250, 20);
  };
  const middle = async () => deep();
  await withUsageCapture({ runId }, rows, async () => middle());

  check("deeply nested call attributed", rows.length === 1 && rows[0].runId === runId, JSON.stringify(rows));
}

console.log("\n== A. concurrent runs do not mix ==");
{
  // Two runs in flight at once must not see each other's rows — the failure mode
  // a module-level array would have.
  const rowsA: UsageRow[] = [];
  const rowsB: UsageRow[] = [];
  const runA = randomUUID();
  const runB = randomUUID();

  await Promise.all([
    withUsageCapture({ runId: runA }, rowsA, async () => {
      fakeCall("intent", 10, 1);
      await new Promise((r) => setTimeout(r, 20));
      fakeCall("planner", 20, 2);
    }),
    withUsageCapture({ runId: runB }, rowsB, async () => {
      await new Promise((r) => setTimeout(r, 5));
      fakeCall("recommendation", 30, 3);
    }),
  ]);

  check("run A kept its own two rows", rowsA.length === 2, String(rowsA.length));
  check("run B kept its own one row", rowsB.length === 1, String(rowsB.length));
  check("no cross-attribution into A", rowsA.every((r) => r.runId === runA));
  check("no cross-attribution into B", rowsB.every((r) => r.runId === runB));
}

console.log("\n== A. rows survive a throw ==");
{
  const rows: UsageRow[] = [];
  let threw = false;
  try {
    await withUsageCapture({ runId: randomUUID() }, rows, async () => {
      fakeCall("intent", 100, 5);
      throw new Error("graph exploded");
    });
  } catch (error) {
    threw = (error as Error).message === "graph exploded";
  }
  check("the error propagates untouched", threw);
  check("the spend before the failure is still recorded", rows.length === 1, String(rows.length));
}

console.log("\n== A. calls outside a capture are not attributed ==");
{
  check("collectedUsage is empty outside a capture", collectedUsage().length === 0);
  // Must not throw — an unaccounted call site degrades to a warning, never an error.
  let threw = false;
  try {
    fakeCall("orphan", 1, 1);
  } catch {
    threw = true;
  }
  check("an orphan call does not throw", !threw);
}

console.log("\n== A. aggregation ==");
{
  const rows: UsageRow[] = [];
  await withUsageCapture({ runId: randomUUID() }, rows, async () => {
    fakeCall("intent", 100, 5);
    fakeCall("planner", 400, 60);
    fakeCall("recommendation", 2500, 700);
  });
  const total = summarizeUsage(rows);
  check("calls counted", total.calls === 3, String(total.calls));
  check("prompt tokens summed", total.promptTokens === 3000, String(total.promptTokens));
  check("completion tokens summed", total.completionTokens === 765, String(total.completionTokens));
  check("total tokens summed", total.totalTokens === 3765, String(total.totalTokens));
  check("empty set aggregates to zero", summarizeUsage([]).calls === 0);
}

console.log("\n== B. flush reaches Postgres ==");
{
  const runId = randomUUID();
  const rows: UsageRow[] = [];
  await withUsageCapture({ runId, userId: null }, rows, async () => {
    fakeCall("intent", 120, 6);
    fakeCall("recommendation", 2400, 640);
  });

  try {
    await flushUsage(rows);
    const stored = await db.select().from(llmUsage).where(eq(llmUsage.runId, runId));
    check("both rows persisted in one insert", stored.length === 2, String(stored.length));
    check(
      "token counts round-trip intact",
      stored.reduce((n, r) => n + r.promptTokens, 0) === 2520,
      JSON.stringify(stored.map((r) => r.promptTokens))
    );
    check("call sites round-trip", stored.every((r) => ["intent", "recommendation"].includes(r.callSite)));
    check("empty flush is a no-op", (await flushUsage([]), true));
  } finally {
    await db.delete(llmUsage).where(eq(llmUsage.runId, runId));
  }
}

// --- Part C: live provider call ------------------------------------------------
if (process.env.RUN_LIVE_USAGE === "1") {
  console.log("\n== C. live: the provider's own counts reach the ledger ==");
  const rows: UsageRow[] = [];
  await withUsageCapture({ runId: randomUUID() }, rows, async () => {
    await createCompletion("test-live", {
      model: INTENT_MODEL,
      temperature: 0,
      max_tokens: 5,
      messages: [{ role: "user", content: "Say OK." }],
    });
  });
  check("one row recorded", rows.length === 1, String(rows.length));
  check("prompt tokens are real (non-zero)", (rows[0]?.promptTokens ?? 0) > 0, JSON.stringify(rows[0]));
  check("completion tokens are real (non-zero)", (rows[0]?.completionTokens ?? 0) > 0, JSON.stringify(rows[0]));
  check("total equals the parts", rows[0]?.totalTokens === rows[0]?.promptTokens + rows[0]?.completionTokens);
  check("not marked failed", rows[0]?.failed === false);
  check("duration measured", (rows[0]?.durationMs ?? 0) > 0);
} else {
  console.log("\n== C. live provider call: SKIPPED (set RUN_LIVE_USAGE=1) ==");
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"} — passed: ${passed}, failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
