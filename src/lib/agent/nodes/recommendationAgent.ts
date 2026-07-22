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
  VerificationFeedback,
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
  toolCalls: [],
};

export async function recommendationAgentNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  const plan = state.plan ?? FALLBACK_PLAN;

  // A rejected verdict already on state means the Verification Agent sent this
  // draft back — this is the regeneration pass, and the verdict IS the feedback.
  // The attempt counter is incremented here because a conditional-edge router
  // returns a route and cannot write state; without this the loop has no guard.
  const rejected = state.verificationResult && !state.verificationResult.approved;
  const feedback: VerificationFeedback | undefined = rejected
    ? {
        issues: state.verificationResult!.issues,
        notes: state.verificationResult!.verificationNotes,
        recommendedFix: state.verificationResult!.recommendedFix,
      }
    : undefined;
  const regenerationAttempts = rejected ? state.regenerationAttempts + 1 : state.regenerationAttempts;

  logHandoff(
    rejected ? "Verification" : "Profile+CareerData",
    "Recommendation",
    rejected ? { regenerate: true, issues: feedback?.issues.length } : { plan: plan.sections }
  );

  const input: RecommendationAgentInput = {
    query: state.query,
    intent: state.intent,
    plan,
    profile: state.profileAgent ?? DEFAULT_PROFILE,
    careerData: state.careerData ?? DEFAULT_CAREER_DATA,
    // Prior turns of this thread, so the answer stays consistent with the
    // conversation — not just the single resolved question. Empty on the first turn.
    history: state.history,
    feedback,
  };
  // Note: careerData is reused as-is. Regeneration re-writes the answer; it does
  // NOT re-run retrieval, so a retry costs one LLM call, not a second full pass.
  const recommendation = await runRecommendationAgent(input);

  return { recommendation, regenerationAttempts };
}
