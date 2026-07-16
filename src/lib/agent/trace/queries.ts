// Persistence for the run audit trace (agent_runs).
//
// Mirrors the conventions of chat/queries.ts: a single narrow insert helper, no
// business logic. Callers are responsible for never letting a trace write break
// the response — the log node and the route both wrap this in try/catch.
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { agentRuns } from "../../../db/schema";
import type { FinalStatus, TraceEvent } from "./types";

export type SaveRunInput = {
  runId: string;
  userId: string;
  query: string;
  intent?: string;
  executionPlan?: unknown;
  trace: TraceEvent[];
  finalStatus: FinalStatus;
  recommendationId?: string;
};

// Insert one run row. `run_id` is unique, so a retry of the same run is a
// conflict rather than a duplicate — we ignore it (the first write wins) so a
// double-log can never throw into the response path.
export async function saveRun(input: SaveRunInput) {
  const rows = await db
    .insert(agentRuns)
    .values({
      runId: input.runId,
      userId: input.userId,
      query: input.query,
      intent: input.intent,
      executionPlan: input.executionPlan,
      trace: input.trace,
      finalStatus: input.finalStatus,
      recommendationId: input.recommendationId,
    })
    .onConflictDoNothing({ target: agentRuns.runId })
    .returning({ id: agentRuns.id });
  return rows[0];
}

// Read a run back by its correlation id. Used by tests and (later) the trace
// viewer; there is no read path in the request flow.
export async function getRunByRunId(runId: string) {
  const rows = await db.select().from(agentRuns).where(eq(agentRuns.runId, runId)).limit(1);
  return rows[0];
}
