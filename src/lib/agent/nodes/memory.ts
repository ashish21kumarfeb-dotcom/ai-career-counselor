// Memory node (SRS memory update): reuses the existing fixed-key extractor +
// upsert to persist durable facts from the USER's message. Fault-tolerant and
// never blocks the response; skipped entirely when state.persist is false
// (tests / dry runs).
//
// It REPORTS its outcome on `memoryUpdate` rather than returning {} regardless.
// It previously could not report honestly even in principle: extractMemories
// swallowed its own LLM error and returned [], which is indistinguishable from
// "the user stated nothing durable" — so a rate-limited extraction traced as a
// successful one. extractMemoriesDetailed draws that distinction; this node
// passes it through so the trace can tell the truth.
import { extractMemoriesDetailed } from "../../ai/memory";
import { upsertMemory } from "../../memory/queries";
import type { AgentStateType, MemoryUpdateReport } from "../state";

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function memoryNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  if (!state.persist) {
    const report: MemoryUpdateReport = { status: "skipped", factsExtracted: 0, factsWritten: 0 };
    return { memoryUpdate: report };
  }

  const extraction = await extractMemoriesDetailed(state.query);
  if (!extraction.available) {
    // The extractor could not run. NOT the same as "no facts to store".
    return {
      memoryUpdate: { status: "failed", factsExtracted: 0, factsWritten: 0, error: extraction.error },
    };
  }

  let factsWritten = 0;
  try {
    for (const fact of extraction.facts) {
      await upsertMemory(state.userId, fact.key, fact.value);
      factsWritten++;
    }
  } catch (error) {
    // A partial write is still a failure to report — factsWritten says how far
    // it got, so the trace does not imply the whole batch landed.
    console.error("Agent memory write failed:", error);
    return {
      memoryUpdate: {
        status: "failed",
        factsExtracted: extraction.facts.length,
        factsWritten,
        error: errText(error),
      },
    };
  }

  return {
    memoryUpdate: { status: "ok", factsExtracted: extraction.facts.length, factsWritten },
  };
}
