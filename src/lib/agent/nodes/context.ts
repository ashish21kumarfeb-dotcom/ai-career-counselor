// Context node: reuses the existing profile / memory / RAG helpers, run in
// parallel (all independent) — the context-loading step of the chat pipeline, as
// a graph node. Reads are safe for an unknown userId (profile -> undefined,
// memory -> []).
import { getProfileByUserId } from "../../profile/queries";
import { getMemoryByUserId } from "../../memory/queries";
import { searchDocuments } from "../../documents/queries";
import type { AgentStateType } from "../state";

export async function contextNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  const [profile, memory, ragDocs] = await Promise.all([
    getProfileByUserId(state.userId),
    getMemoryByUserId(state.userId),
    // User-scoped RAG: global curated docs + this user's own docs (e.g. resume),
    // never another user's.
    searchDocuments(state.query, state.userId),
  ]);
  return { profile, memory, ragDocs };
}
