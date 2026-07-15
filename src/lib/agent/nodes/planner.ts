// Planner node: an LLM EXECUTION planner (not an if/else, and no longer just a
// section selector). It reads the query + intent and proposes a full plan — the
// goal, the context it needs, the agents and tools it intends to use, and the
// sections it expects to produce.
//
// It PROPOSES; it does not decide. finalizeExecutionPlan() validates every name
// against the registry, forces the structurally required agents back in, applies
// the deterministic gates, derives the tool list from the GATED sections, and
// computes the risk checks itself — a model never authors its own risk
// assessment. See plan/registry.ts for which fields the graph enforces and which
// it merely declares; that distinction is deliberate.
//
// Fully fault-tolerant: on any LLM/parse/validation failure it falls back to a
// gate-safe plan derived from the query, marked degraded:true so the trace and
// the demo can tell a modelled plan from a regex one. The graph always gets a
// valid plan, and `plan: AgentPlan` keeps its exact previous shape so
// /api/agent-chat and the UI are untouched.
import { getGroq, CHAT_MODEL } from "../../ai/client";
import { plannerProposalSchema, PROMPT_VOCABULARY, type PlannerProposal } from "../plan/types";
import { finalizeExecutionPlan, fallbackProposal } from "../plan/finalize";
import type { AgentStateType } from "../state";

// Re-exported for the existing planner tests, which assert the fail-closed rule
// directly. The implementation now lives in plan/finalize.ts so that this node can
// depend on it without an import cycle.
export { fallbackNeeds } from "../plan/finalize";

const PLANNER_PROMPT = `You are the EXECUTION PLANNER for an enterprise AI career-guidance workflow. Produce a plan for THIS query: what the user actually wants, what context is needed, which agents and tools should run, and which response sections to produce.

Respond ONLY with a JSON object of this exact shape:
{"goal":"one sentence restating what the user wants","requiredContext":[...],"agents":[...],"tools":[{"tool":"...","reason":"why this tool"}],"expectedSections":[...],"reasoning":"one short sentence"}

Allowed values — use ONLY these:
- requiredContext: ${PROMPT_VOCABULARY.context}
- agents: ${PROMPT_VOCABULARY.agents}
- tools: ${PROMPT_VOCABULARY.tools}
- expectedSections: ${PROMPT_VOCABULARY.sections}

Sections — enable one only if it genuinely helps answer THIS query. A query can need one, or several. Do NOT enable everything by default.
- ai_suggestion: a direct answer, recommendation, or comparison.
- roadmap: a step-by-step plan or learning path.
- resources: curated learning resource or article links.
- courses: course or certification links.
- skill_focus: the specific skills to focus on or close a gap on.
- agencies: career counselling / consulting / mentoring / recruitment providers.
- next_steps: a few concrete immediate actions.

Rules:
- Enable "agencies" ONLY if the user asks for help from a HUMAN provider — a counsellor, consultant, mentor, coach, agency, recruiter, or placement service. Never enable it just because the user asks a career question.
- Enable "resources"/"courses"/"skill_focus" ONLY if the user asks about learning, a roadmap, skills, courses, certification, or preparation (or clearly implies it, e.g. switching into a new field).
- Most simple questions need only "ai_suggestion", sometimes with "roadmap".
- Request a tool only if a section you planned needs it. searchDocuments is always available for grounding.
- Agents: this workflow runs ALL FOUR on every request, so list all four every time — profile (loads profile + memory), career_data (retrieval), recommendation (writes the answer), verification (checks it). Omitting one does not skip it; it is forced back in and recorded as a planning error.`;

async function proposePlan(state: AgentStateType): Promise<PlannerProposal> {
  const userInput = `User query: ${JSON.stringify(state.query)}
Detected intent: ${state.intent}`;

  const completion = await getGroq().chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0,
    max_tokens: 500,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: PLANNER_PROMPT },
      { role: "user", content: userInput },
    ],
  });
  const raw = completion.choices[0]?.message?.content ?? "";
  return plannerProposalSchema.parse(JSON.parse(raw));
}

export async function plannerNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  let proposal: PlannerProposal;
  let degraded = false;

  try {
    proposal = await proposePlan(state);
  } catch (error) {
    console.error("Planner LLM failed; using fallback plan:", error);
    proposal = fallbackProposal(state.query);
    degraded = true;
  }

  const { executionPlan, plan } = finalizeExecutionPlan(proposal, state.query, degraded);
  return { executionPlan, plan };
}
