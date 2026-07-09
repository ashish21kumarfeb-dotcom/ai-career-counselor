// Intent node: reuses the existing classifyIntent slice unchanged. Fault-tolerant
// already (returns "other" on any error), so no extra guarding needed here.
import { classifyIntent } from "../../ai/intent";
import type { AgentStateType } from "../state";

export async function intentNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  const intent = await classifyIntent(state.query);
  return { intent };
}
