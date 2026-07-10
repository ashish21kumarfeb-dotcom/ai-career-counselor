// Memory node (SRS memory update): reuses the existing fixed-key extractor +
// upsert to persist durable facts from the USER's message. Fault-tolerant and
// never blocks the response; skipped entirely when state.persist is false
// (tests / dry runs).
import { extractMemories } from "../../ai/memory";
import { upsertMemory } from "../../memory/queries";
import type { AgentStateType } from "../state";

export async function memoryNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  if (!state.persist) return {};
  try {
    const facts = await extractMemories(state.query);
    for (const fact of facts) {
      await upsertMemory(state.userId, fact.key, fact.value);
    }
  } catch (error) {
    console.error("Agent memory write failed:", error);
  }
  return {};
}
