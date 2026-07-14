// Planner node: an LLM planner (NOT an if/else) that reads the query + intent +
// available context and decides which sections this specific response needs. It
// proposes booleans; finalizePlan() then applies the deterministic gates. Fully
// fault-tolerant: on any LLM/parse/validation failure it falls back to a gate-safe
// plan derived from the query, so the graph always gets a valid plan.
import { getGroq, CHAT_MODEL } from "../../ai/client";
import {
  plannerNeedsSchema,
  finalizePlan,
  agencyGate,
  resourceGate,
  type PlannerNeeds,
} from "../schema";
import type { AgentStateType } from "../state";

const PLANNER_PROMPT = `You are the PLANNER for an AI career counselor. Decide which response sections THIS user query needs. A single query can need 1, 2, or 3+ sections — or just one. Do NOT enable every section by default; enable a section only if it genuinely helps answer this exact query.

Sections you may enable (set true/false under "needs"):
- aiSuggestion: a direct answer, recommendation, or comparison for the user's question.
- roadmap: a step-by-step plan or learning path.
- resources: curated learning resource or article links.
- courses: course or certification links.
- skillFocus: the specific skills the user should focus on or close the gap on.
- agencies: career counselling / consulting / mentoring agencies.
- nextSteps: a few concrete immediate next actions.

Rules:
- Enable "agencies" ONLY if the user asks for help from a human provider — a counsellor, consultant, mentor, coach, agency, or guidance provider. Never enable it just because the user asks a career question.
- Enable "resources"/"courses"/"skillFocus" ONLY if the user asks about learning, a roadmap, skills, courses, certification, or preparation (or clearly implies it, e.g. switching into a new field).
- Most simple questions need only "aiSuggestion", sometimes with "roadmap".

Respond ONLY with a JSON object of this exact shape:
{"needs":{"aiSuggestion":bool,"roadmap":bool,"resources":bool,"courses":bool,"skillFocus":bool,"agencies":bool,"nextSteps":bool},"reasoning":"one short sentence"}`;

// Gate-safe fallback used when the LLM call or its output fails validation.
function fallbackNeeds(query: string): PlannerNeeds {
  return {
    needs: {
      aiSuggestion: true,
      roadmap: /\b(roadmap|plan|steps|how (?:do|to)|become|switch|transition)\b/i.test(query),
      resources: resourceGate(query),
      courses: /\b(course\w*|certif\w*|training)\b/i.test(query),
      skillFocus: /\b(skill\w*|learn\w*|roadmap|become|switch|transition|prepar\w*|gap)\b/i.test(query),
      agencies: agencyGate(query),
      nextSteps: false,
    },
    reasoning: "fallback plan (planner LLM unavailable or returned invalid output)",
  };
}

export async function plannerNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  // Planner runs before the Profile / Career Data agents in the A2A graph, so it
  // decides sections from the query + intent alone. The deterministic gates
  // (finalizePlan) still carry the safety-critical filtering.
  const userInput = `User query: ${JSON.stringify(state.query)}
Detected intent: ${state.intent}`;

  let proposed: PlannerNeeds;
  try {
    const completion = await getGroq().chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PLANNER_PROMPT },
        { role: "user", content: userInput },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = plannerNeedsSchema.safeParse(JSON.parse(raw));
    proposed = parsed.success ? parsed.data : fallbackNeeds(state.query);
    if (!parsed.success) {
      console.warn("Planner output failed validation; using fallback plan.");
    }
  } catch (error) {
    console.error("Planner LLM failed; using fallback plan:", error);
    proposed = fallbackNeeds(state.query);
  }

  const plan = finalizePlan(proposed, state.query);
  return { plan };
}
