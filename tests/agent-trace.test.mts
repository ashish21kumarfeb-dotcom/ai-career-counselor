// Audit-trace tests. Three parts:
//   A) pure units for the recorder (no DB, no LLM)
//   B) persistence against a real throwaway user (needs DATABASE_URL)
//   C) a live end-to-end graph run asserting a well-formed ordered trace row
//      (needs DATABASE_URL + GROQ_API_KEY)
// Run: npm run test:trace
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index";
import { users, agentRuns, aiRecommendations, memory } from "../src/db/schema";
import { traced, boundDetail } from "../src/lib/agent/trace/recorder";
import { saveRun, getRunByRunId } from "../src/lib/agent/trace/queries";
import { persistTraceNode, deriveFinalStatus } from "../src/lib/agent/nodes/persistTrace";
import { agentGraph } from "../src/lib/agent/graph";
import { TRACE_EVENT_TYPES, TRACE_STATUSES } from "../src/lib/agent/trace/types";
import type { TraceEvent } from "../src/lib/agent/trace/types";
import type { AgentStateType } from "../src/lib/agent/state";
import type { VerificationAgentOutput } from "../src/lib/agent/agents/contracts";

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

function makeState(over: Partial<AgentStateType>): AgentStateType {
  return {
    userId: "00000000-0000-0000-0000-000000000000",
    query: "",
    runId: "",
    trace: [],
    recommendationId: undefined,
    persist: false,
    intent: "other",
    profile: undefined,
    memory: [],
    ragDocs: [],
    plan: undefined,
    toolResults: { agencies: [], resources: [] },
    sections: undefined,
    verification: undefined,
    evaluation: undefined,
    profileAgent: undefined,
    careerData: undefined,
    recommendation: undefined,
    verificationResult: undefined,
    ...over,
  };
}

function verdict(over: Partial<VerificationAgentOutput>): VerificationAgentOutput {
  return {
    approved: true, grounded: true, safe: true, softCheckAvailable: true,
    issues: [], verificationNotes: "", finalSections: {},
    ...over,
  };
}

// ============ A. Recorder units (no DB, no LLM) ============
console.log("\n== A. boundDetail ==");
{
  const long = "x".repeat(500);
  const out = boundDetail({ s: long })!;
  check("truncates a long string", (out.s as string).length <= 300);
  check("marks truncation with an ellipsis", (out.s as string).endsWith("…"));
}
{
  const out = boundDetail({ arr: ["y".repeat(500), "short"] })!;
  check("truncates strings inside arrays", ((out.arr as string[])[0]).length <= 300);
  check("leaves short strings alone", (out.arr as string[])[1] === "short");
}
{
  // Many short keys that individually pass but collectively blow the cap.
  const big: Record<string, unknown> = {};
  for (let i = 0; i < 100; i++) big[`k${i}`] = "z".repeat(250);
  const out = boundDetail(big)!;
  check("caps oversized detail wholesale", out.truncated === true, JSON.stringify(out).slice(0, 80));
}
{
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const out = boundDetail(circular)!;
  check("survives circular detail", out.unserializable === true);
  check("boundDetail(undefined) is undefined", boundDetail(undefined) === undefined);
}

console.log("\n== A. traced() wrapper ==");
{
  const node = async () => ({ intent: "job_search" as const });
  const wrapped = traced("extract_intent", "intent", node, (p) => ({ summary: `intent: ${p.intent}` }));
  const out = await wrapped(makeState({}));
  const ev = (out.trace as TraceEvent[])[0];
  check("returns the node's own partial untouched", out.intent === "job_search");
  check("appends exactly one event", (out.trace as TraceEvent[]).length === 1);
  check("event carries step + type", ev.step === "extract_intent" && ev.type === "intent");
  check("event defaults to status ok", ev.status === "ok");
  check("event carries the summary", ev.summary === "intent: job_search");
  check("event has an ISO timestamp", !Number.isNaN(Date.parse(ev.at)));
  check("event type is in the vocabulary", (TRACE_EVENT_TYPES as readonly string[]).includes(ev.type));
  check("event status is in the vocabulary", (TRACE_STATUSES as readonly string[]).includes(ev.status));
  check("durationMs is a number", typeof ev.durationMs === "number" && ev.durationMs >= 0);
}
{
  // seq is derived from how many events already exist on state.
  const prior: TraceEvent[] = [
    { seq: 0, at: "", step: "a", type: "intent", status: "ok", durationMs: 0, summary: "" },
    { seq: 1, at: "", step: "b", type: "plan", status: "ok", durationMs: 0, summary: "" },
  ];
  const wrapped = traced("planner", "plan", async () => ({}), () => ({ summary: "s" }));
  const out = await wrapped(makeState({ trace: prior }));
  check("seq continues from existing trace length", (out.trace as TraceEvent[])[0].seq === 2);
}
{
  const wrapped = traced("planner", "plan", async () => ({}), () => ({ status: "degraded" as const, summary: "fell back" }));
  const out = await wrapped(makeState({}));
  check("summarizer can mark a run degraded", (out.trace as TraceEvent[])[0].status === "degraded");
}
{
  // A node that throws must NOT be swallowed: /api/agent-chat's 502 path is part
  // of the Phase 1 contract.
  const boom = async () => { throw new Error("db down"); };
  const wrapped = traced("profile_agent", "agent", boom, () => ({ summary: "" }));
  let threw = false;
  try { await wrapped(makeState({})); } catch { threw = true; }
  check("re-throws a node error rather than swallowing it", threw);
}
{
  // A broken summarizer must never break the run it observes.
  const wrapped = traced("evaluate", "evaluation", async () => ({ intent: "other" as const }), () => {
    throw new Error("bad summarizer");
  });
  const out = await wrapped(makeState({}));
  check("survives a throwing summarizer", (out.trace as TraceEvent[]).length === 1);
  check("records the summarizer failure as degraded", (out.trace as TraceEvent[])[0].status === "degraded");
  check("still returns the node's partial", out.intent === "other");
}

console.log("\n== A. deriveFinalStatus ==");
{
  check("approved verdict -> approved", deriveFinalStatus(makeState({ verificationResult: verdict({ approved: true }) })) === "approved");
  check("rejected verdict -> corrected", deriveFinalStatus(makeState({ verificationResult: verdict({ approved: false }) })) === "corrected");
  check("no verdict -> failed", deriveFinalStatus(makeState({ verificationResult: undefined })) === "failed");
}

// ============ B + C. DB-backed ============
if (!process.env.DATABASE_URL) {
  console.log("\n== B/C. DB == (skipped: no DATABASE_URL)");
} else {
  const email = "tracetest+verify@example.test";
  await db.delete(users).where(eq(users.email, email));
  const [u] = await db.insert(users).values({ name: "Trace Test", email }).returning({ id: users.id });
  const userId = u.id;

  try {
    console.log("\n== B. persistence ==");
    {
      const runId = crypto.randomUUID();
      await saveRun({ runId, userId, query: "q", intent: "other", trace: [], finalStatus: "approved" });
      const row = await getRunByRunId(runId);
      check("saveRun writes a readable row", !!row && row.runId === runId);
      check("finalStatus round-trips", row?.finalStatus === "approved");
      // run_id is unique: a double-write must not throw into the response path.
      let threw = false;
      try {
        await saveRun({ runId, userId, query: "q", trace: [], finalStatus: "failed" });
      } catch { threw = true; }
      check("duplicate runId does not throw (onConflictDoNothing)", !threw);
      const after = await getRunByRunId(runId);
      check("first write wins on conflict", after?.finalStatus === "approved");
    }
    {
      const runId = crypto.randomUUID();
      await persistTraceNode(makeState({ runId, userId, persist: false, verificationResult: verdict({}) }));
      check("persist:false writes no run row", !(await getRunByRunId(runId)));
    }
    {
      // No correlation id -> a row we could never correlate. Skip, don't guess.
      const before = await db.select().from(agentRuns).where(eq(agentRuns.userId, userId));
      await persistTraceNode(makeState({ runId: "", userId, persist: true, verificationResult: verdict({}) }));
      const after = await db.select().from(agentRuns).where(eq(agentRuns.userId, userId));
      check("missing runId writes no run row", after.length === before.length);
    }

    if (!process.env.GROQ_API_KEY) {
      console.log("\n== C. live graph == (skipped: no GROQ_API_KEY)");
    } else {
      console.log("\n== C. live graph run ==");
      const runId = crypto.randomUUID();
      const result = await agentGraph.invoke({
        userId,
        runId,
        query: "How do I move from manual testing into data analysis?",
      });

      // The response contract must be untouched by Phase 1.
      const responseKeys = ["intent", "plan", "sections", "verification", "evaluation"] as const;
      check("response channels all still populated", responseKeys.every((k) => result[k] !== undefined), JSON.stringify(Object.keys(result)));

      const row = await getRunByRunId(runId);
      check("live run writes exactly one agent_runs row", !!row);
      check("row links to the ai_recommendations row", !!row?.recommendationId);
      check("row carries the query", row?.query === "How do I move from manual testing into data analysis?");
      check("row finalStatus is a real status", ["approved", "corrected"].includes(row?.finalStatus ?? ""));

      const trace = (row?.trace ?? []) as TraceEvent[];
      const steps = trace.map((e) => e.step);
      check("trace persisted with events", trace.length > 0, `len=${trace.length}`);
      check(
        "trace covers every traced node",
        ["extract_intent", "planner", "profile_agent", "career_data_agent", "recommendation_agent", "verification_agent", "update_memory", "evaluate", "log_turn"].every((s) => steps.includes(s)),
        JSON.stringify(steps)
      );
      check("persist_trace does not trace itself", !steps.includes("persist_trace"));
      check("seq is dense and ordered", trace.every((e, i) => e.seq === i), JSON.stringify(trace.map((e) => e.seq)));
      check("events are in execution order", steps[0] === "extract_intent" && steps[steps.length - 1] === "log_turn");
      check("every event has a summary", trace.every((e) => typeof e.summary === "string" && e.summary.length > 0));
      check("every status is in the vocabulary", trace.every((e) => (TRACE_STATUSES as readonly string[]).includes(e.status)));
      console.log(`\n  --- trace ---`);
      for (const e of trace) console.log(`  ${String(e.seq).padStart(2)}. [${e.status.padEnd(8)}] ${e.step.padEnd(20)} ${e.durationMs}ms  ${e.summary}`);
    }
  } finally {
    await db.delete(agentRuns).where(eq(agentRuns.userId, userId));
    await db.delete(aiRecommendations).where(eq(aiRecommendations.userId, userId));
    await db.delete(memory).where(eq(memory.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    console.log("\ncleaned up throwaway user + rows.");
  }
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
