// Intent node: structured intent + slot extraction (extractIntent). The label
// keeps the exact previous shape and fault tolerance ("other" on any failure);
// the slots are additive. A degraded extraction leaves intentSlots undefined so
// downstream consumers (lanes.ts, searchStrategy) fall back to the regex gates.
import { extractIntent } from "../../ai/extractIntent";
import type { AgentStateType } from "../state";

export async function intentNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  const extraction = await extractIntent(state.query);
  return {
    intent: extraction.intent,
    intentSlots: extraction.degraded ? undefined : extraction.slots,
  };
}
