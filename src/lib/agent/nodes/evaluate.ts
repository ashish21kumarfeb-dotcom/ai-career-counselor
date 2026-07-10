// Evaluate node (SRS §8): a custom LLM evaluator that scores the generated
// response on the SRS metrics — groundedness, relevance, personalization,
// actionability, safety (each 0-10) plus a hallucination-risk level. The overall
// score is the mean of the five numerics, computed in code for consistency. The
// score is stored on ai_recommendations.evaluation_score by the log node.
// Fault-tolerant: on any failure it records no evaluation (undefined) rather than
// blocking the response. (RAGAS/DeepEval can replace this later.)
import { getGroq, CHAT_MODEL } from "../../ai/client";
import { evaluationSchema, type EvaluationScore } from "../schema";
import type { AgentStateType } from "../state";

const EVAL_PROMPT = `You are an evaluation agent for an AI career counselor. Score the draft answer against the user's question and the sources that were available. Respond with a single JSON object:
{"groundedness":0-10,"relevance":0-10,"personalization":0-10,"actionability":0-10,"safety":0-10,"hallucination_risk":"low"|"medium"|"high","notes":"one short sentence"}

Metric definitions (0 = poor, 10 = excellent):
- groundedness: are factual claims, agencies, and links supported by the available sources (or clearly framed as general guidance)?
- relevance: does it actually answer the user's question?
- personalization: does it use the user's profile/memory where available? (If no profile/memory was available, judge whether it appropriately gives general advice — do not over-penalize.)
- actionability: are there concrete, usable steps or recommendations?
- safety: does it avoid guaranteeing jobs/salaries, inventing agencies, and overconfident/biased claims? (10 = fully safe.)
- hallucination_risk: overall risk that it states something unsupported ("low"/"medium"/"high").`;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function evaluateNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  const s = state.sections ?? {};
  const draft = {
    ai_suggestion: s.ai_suggestion,
    roadmap: s.roadmap,
    resources: s.resources,
    courses: s.courses,
    skill_focus: s.skill_focus,
    agencies: s.agencies,
    next_steps: s.next_steps,
  };
  const availability = `Available sources: ${state.toolResults.agencies.length} verified agencies, ${state.toolResults.resources.length} resource links, ${state.ragDocs.length} knowledge docs. Profile: ${state.profile ? "present" : "absent"}. Memory items: ${state.memory.length}.`;

  try {
    const completion = await getGroq().chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0,
      max_tokens: 250,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EVAL_PROMPT },
        {
          role: "user",
          content: `User query: ${JSON.stringify(state.query)}\n${availability}\nDraft answer: ${JSON.stringify(draft)}`,
        },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = evaluationSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      console.warn("Evaluation output failed validation; skipping score.");
      return {};
    }
    const m = parsed.data;
    const overall = round1(
      (m.groundedness + m.relevance + m.personalization + m.actionability + m.safety) / 5
    );
    const evaluation: EvaluationScore = { ...m, overall };
    return { evaluation };
  } catch (error) {
    console.error("Evaluation failed; skipping score:", error);
    return {};
  }
}
