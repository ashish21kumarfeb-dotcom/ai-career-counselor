// Recommendation Agent node — thin LangGraph adapter around runRecommendationAgent.
//
// A2A hand-off: builds the Recommendation input DTO from BOTH upstream envelopes
// (state.profileAgent + state.careerData) — the explicit message passing. Writes the
// `recommendation` envelope (draft sections). The FINAL state.sections is set later
// by the Verification node, after sanitization.
import { runRecommendationAgent } from "../agents/recommendation";
import { logHandoff } from "../a2a";
import type {
  RecommendationAgentInput,
  ProfileAgentOutput,
  CareerDataAgentOutput,
} from "../agents/contracts";
import type { AgentStateType } from "../state";
import type { AgentPlan, SectionName } from "../schema";

const FALLBACK_PLAN: AgentPlan = { sections: ["ai_suggestion"] as SectionName[], reasoning: "fallback" };

const DEFAULT_PROFILE: ProfileAgentOutput = {
  profileSummary: "No profile on file for this user.",
  memorySummary: "No stored memory for this user.",
  userContext: { stage: null, currentRole: null, skills: [], interests: [], careerGoal: null, location: null },
  importantConstraints: [],
};

const DEFAULT_CAREER_DATA: CareerDataAgentOutput = {
  ragDocs: [],
  resources: [],
  courses: [],
  agencies: [],
  sourcesUsed: [],
  missingDataNotes: [],
};

export async function recommendationAgentNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  const plan = state.plan ?? FALLBACK_PLAN;
  logHandoff("Profile+CareerData", "Recommendation", { plan: plan.sections });

  const input: RecommendationAgentInput = {
    query: state.query,
    intent: state.intent,
    plan,
    profile: state.profileAgent ?? DEFAULT_PROFILE,
    careerData: state.careerData ?? DEFAULT_CAREER_DATA,
  };
  const recommendation = await runRecommendationAgent(input);

  return { recommendation };
}
