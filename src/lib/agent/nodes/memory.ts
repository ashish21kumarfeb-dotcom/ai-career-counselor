// Memory node (SRS memory update): reuses the existing fixed-key extractor +
// upsert to persist durable facts from the USER's message. Fault-tolerant and
// never blocks the response; skipped entirely when state.persist is false
// (tests / dry runs).
//
// EXTRACTS FROM THE RAW USER MESSAGE (`originalQuery`), not from `query`. The
// resolve_query node overwrites `query` with an LLM rewrite, and memory is the one
// write in this graph that outlives the run — so extracting from the rewrite would
// launder a rewriter hallucination into permanent user state. Worse, the guard that
// should catch that is structurally unable to: isGrounded() in ai/memory.ts checks
// each extracted value against the very text it was extracted from, so a fact
// invented by the rewriter validates against the rewrite and is stored. Reading
// originalQuery makes the grounding check meaningful again — it now compares the
// fact against what the USER actually typed.
//
// Falls back to `query` when originalQuery is empty: it defaults to "" and is only
// populated once resolve_query has run, so a direct/partial graph invocation (tests)
// would otherwise extract from nothing.
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

  const sourceText = state.originalQuery || state.query;
  const extraction = await extractMemoriesDetailed(sourceText);
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
