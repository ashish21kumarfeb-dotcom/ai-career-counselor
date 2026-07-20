import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../../db";
import { llmUsage } from "../../db/schema";
import { getGroq } from "./client";
import type { ChatCompletionCreateParamsNonStreaming } from "groq-sdk/resources/chat/completions";

// Token accounting for every LLM call in the system.
//
// THE PROBLEM THIS SOLVES. A single /api/agent-chat run makes up to seven LLM
// calls across seven modules — intent, query resolution, planner, recommendation,
// possibly a regeneration, verification, evaluation — and nothing recorded what
// any of them cost. "The prompt is getting long" was an impression, not a
// measurement, and the context that gets injected (profile + memory + RAG +
// external results) grows with the corpus, so the impression was going to keep
// getting worse without anyone being able to say by how much.
//
// WHY AN AMBIENT CONTEXT RATHER THAN A PARAMETER. The call sites are plain
// functions — classifyIntent(message), extractMemories(text) — several layers
// below the route that knows the run id. Threading a run id down to them would
// mean changing the signature of every function on every path, including ones
// that have nothing to do with usage, and would leave the recording optional at
// each site (a new call site would simply forget). AsyncLocalStorage carries the
// run identity implicitly across the await chain instead, so the wrapper below is
// the only place that needs to know anything, and any call that goes through it
// is accounted for whether or not its author thought about usage. This runs on
// the Node runtime, where ALS is available; a call made with no ambient run is
// still recorded, with a null run id, rather than dropped.
//
// WHY BUFFER AND FLUSH ONCE. On the neon-http driver every statement is a
// separate HTTP round trip. Writing a row per call would add seven of them to a
// request that is already latency-sensitive. The buffer collects rows in memory
// during the run and the route flushes them in one multi-row insert.

export type UsageRow = {
  runId: string | null;
  userId: string | null;
  callSite: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  failed: boolean;
};

type UsageContext = {
  runId: string | null;
  userId: string | null;
  rows: UsageRow[];
};

const storage = new AsyncLocalStorage<UsageContext>();

// Runs `fn` with the caller's array bound as the usage buffer for this async
// context.
//
// The buffer is passed IN rather than returned, which looks backwards until you
// consider the failure path: a run that throws is exactly the run whose cost you
// want to see, and if the rows came back only as a return value they would be
// lost on the throw. The caller holding the array can flush it from a catch or a
// finally. `fn`'s rejection propagates untouched.
export async function withUsageCapture<T>(
  identity: { runId?: string | null; userId?: string | null },
  rows: UsageRow[],
  fn: () => Promise<T>
): Promise<T> {
  const context: UsageContext = {
    runId: identity.runId ?? null,
    userId: identity.userId ?? null,
    rows,
  };
  return storage.run(context, fn);
}

// The rows collected so far in the current context. Empty outside a capture.
export function collectedUsage(): UsageRow[] {
  return storage.getStore()?.rows ?? [];
}

// Attribute a completed model call to the ambient run. Exported because the Groq
// wrapper below is not the only possible spender — a future provider client, or
// anything that consumes tokens through another SDK, records through here and
// lands in the same ledger rather than starting a second one.
export function recordUsage(row: Omit<UsageRow, "runId" | "userId">): void {
  const context = storage.getStore();
  if (!context) {
    // No ambient run — a call made outside withUsageCapture. Recorded to the log
    // rather than silently dropped, so an unaccounted call site is discoverable
    // instead of just missing from the totals.
    console.warn(
      `[usage] LLM call at "${row.callSite}" ran outside a usage capture; not persisted.`,
      row
    );
    return;
  }
  context.rows.push({ runId: context.runId, userId: context.userId, ...row });
}

// Pinned to the NON-STREAMING params type. Nothing here streams, and the
// non-streaming overload is what makes the return type a plain ChatCompletion
// with `choices` and `usage` on it — the streaming union would force every one of
// the seven call sites to narrow a type they never actually receive. If streaming
// is added later it needs its own wrapper, because usage arrives in the final
// chunk rather than on the response object.
type CompletionParams = ChatCompletionCreateParamsNonStreaming;

// THE single choke point for talking to the model. Every call site goes through
// it, which is what makes the ledger complete by construction rather than by
// everyone remembering. `callSite` is the label the numbers get grouped by, so it
// names the STAGE ("intent", "verification") rather than the function.
//
// Usage comes from the provider's own `usage` field. When a provider omits it the
// row is still written with zeros — a call that happened with unknown cost is a
// different and more useful fact than no row at all.
export async function createCompletion(
  callSite: string,
  params: CompletionParams
) {
  const startedAt = Date.now();
  const model = typeof params.model === "string" ? params.model : "unknown";

  try {
    const completion = await getGroq().chat.completions.create(params);
    // Optional even on the non-streaming type: a provider may omit it.
    const usage = completion.usage;
    recordUsage({
      callSite,
      model,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
      durationMs: Date.now() - startedAt,
      failed: false,
    });
    return completion;
  } catch (error) {
    // A failed call still consumed wall-clock, and on a rate-limit or timeout it
    // may have consumed tokens upstream. Record it, then re-throw untouched —
    // every existing caller's error handling must behave exactly as before.
    recordUsage({
      callSite,
      model,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      durationMs: Date.now() - startedAt,
      failed: true,
    });
    throw error;
  }
}

// Persist a batch. Best-effort by design: accounting must never be able to fail a
// request that already produced a good answer for the user.
export async function flushUsage(rows: UsageRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await db.insert(llmUsage).values(rows);
  } catch (error) {
    console.error("[usage] flush failed:", error);
  }
}

// Convenience for reading a run's cost back out of a row set — used by the trace
// summary and by the tests, so the aggregation is defined once.
export function summarizeUsage(rows: UsageRow[]) {
  return rows.reduce(
    (acc, r) => ({
      calls: acc.calls + 1,
      promptTokens: acc.promptTokens + r.promptTokens,
      completionTokens: acc.completionTokens + r.completionTokens,
      totalTokens: acc.totalTokens + r.totalTokens,
      durationMs: acc.durationMs + r.durationMs,
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0 }
  );
}
