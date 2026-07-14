// Career Data Agent node — thin LangGraph adapter around runCareerDataAgent.
//
// A2A hand-off: builds the Career Data input DTO from state, taking the userContext
// FROM the Profile Agent's envelope (state.profileAgent) — the explicit message
// passing. Writes the `careerData` envelope, and rebuilds the backward-compat
// `toolResults` + `ragDocs` channels (ids/types/urls for the log node's
// sources_used; array lengths for the evaluate node) directly from the envelope.
import { runCareerDataAgent } from "../agents/careerData";
import { logHandoff } from "../a2a";
import type { CareerDataAgentInput, UserContext } from "../agents/contracts";
import type { AgentStateType, ToolResults } from "../state";

const EMPTY_CONTEXT: UserContext = {
  stage: null,
  currentRole: null,
  skills: [],
  interests: [],
  careerGoal: null,
  location: null,
};

export async function careerDataAgentNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  const userContext = state.profileAgent?.userContext ?? EMPTY_CONTEXT;
  logHandoff("Profile", "CareerData", userContext);

  const input: CareerDataAgentInput = {
    userId: state.userId,
    query: state.query,
    intent: state.intent,
    plannedSections: state.plan?.sections ?? ["ai_suggestion"],
    userContext,
  };
  const careerData = await runCareerDataAgent(input);

  // Compat channels rebuilt from the envelope's sourcesUsed (which carries the row
  // ids) and ragDocs. The content/name fields are unused downstream in the new
  // graph (only ids/types/urls and lengths are read), so they are left empty.
  const toolResults: ToolResults = {
    agencies: careerData.sourcesUsed
      .filter((s) => s.type === "agency")
      .map((s) => ({ id: s.id, name: "", location: null, services: null, website: null, sourceUrl: s.sourceUrl })),
    resources: careerData.sourcesUsed
      .filter((s) => s.type !== "agency")
      .map((s) => ({ id: s.id, type: s.type, content: "", sourceUrl: s.sourceUrl })),
  };

  return { careerData, ragDocs: careerData.ragDocs, toolResults };
}
