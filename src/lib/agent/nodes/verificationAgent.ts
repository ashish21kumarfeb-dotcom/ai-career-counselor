// Verification Agent node — thin LangGraph adapter around runVerificationAgent.
//
// A2A hand-off: builds the Verification input from the Recommendation Agent's draft
// (state.recommendation) plus the Career Data envelope. Runs the enforcing verifier
// (deterministic hard checks + sanitize, plus the default Groq soft check). Writes:
//   - `verificationResult` (full envelope: approved, issues, softCheckAvailable, ...)
//   - `verification` (backward-compat UI-facing {grounded, safe, notes})
//   - `sections` (the SANITIZED final sections the evaluate + log nodes and the API
//     response consume — never the raw draft).
import { runVerificationAgent } from "../agents/verification";
import { logHandoff } from "../a2a";
import type { VerificationAgentInput, CareerDataAgentOutput } from "../agents/contracts";
import type { AgentStateType } from "../state";
import type { AgentPlan, ResponseSections, Verification, SectionName } from "../schema";

const FALLBACK_PLAN: AgentPlan = { sections: ["ai_suggestion"] as SectionName[], reasoning: "fallback" };

const DEFAULT_CAREER_DATA: CareerDataAgentOutput = {
  ragDocs: [],
  resources: [],
  courses: [],
  agencies: [],
  sourcesUsed: [],
  missingDataNotes: [],
  toolCalls: [],
};

export async function verificationAgentNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  const plan = state.plan ?? FALLBACK_PLAN;
  const draftSections: ResponseSections = state.recommendation?.draftSections ?? {};
  const careerData = state.careerData ?? DEFAULT_CAREER_DATA;
  logHandoff("Recommendation", "Verification", { sections: Object.keys(draftSections) });

  // `profile` is passed for GROUNDING EVIDENCE only — the verifier never uses it to
  // personalize, just to recognize that a figure about the user came from the user.
  const input: VerificationAgentInput = {
    query: state.query,
    plan,
    draftSections,
    careerData,
    profile: state.profileAgent,
  };
  const verificationResult = await runVerificationAgent(input);

  // Backward-compat UI-facing verdict. Note (correction #1): when the soft check was
  // unavailable, grounded/safe are false (not confirmed) and the notes say so — the
  // UI renders the honest "flagged / not confirmed" state.
  const verification: Verification = {
    grounded: verificationResult.grounded,
    safe: verificationResult.safe,
    notes: verificationResult.verificationNotes,
  };

  return {
    verificationResult,
    verification,
    sections: verificationResult.finalSections,
  };
}
