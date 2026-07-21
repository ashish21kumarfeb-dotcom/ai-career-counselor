// Profile Agent node — thin LangGraph adapter around runProfileAgent.
//
// Builds the Profile Agent's input DTO from state, calls the standalone core, and
// writes the `profileAgent` envelope. It also populates the backward-compat `profile`
// and `memory` channels the (unchanged) evaluate node reads — profile presence and
// memory count — via cheap indexed reads.
import { runProfileAgent } from "../agents/profile";
import { getProfileByUserId } from "../../profile/queries";
import { getMemoryByUserId } from "../../memory/queries";
import type { ProfileAgentInput } from "../agents/contracts";
import type { AgentStateType } from "../state";

export async function profileAgentNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  const input: ProfileAgentInput = {
    userId: state.userId,
    query: state.query,
  };

  const [profileAgent, profile, memory] = await Promise.all([
    runProfileAgent(input),
    getProfileByUserId(state.userId),
    getMemoryByUserId(state.userId),
  ]);

  return { profileAgent, profile, memory };
}
