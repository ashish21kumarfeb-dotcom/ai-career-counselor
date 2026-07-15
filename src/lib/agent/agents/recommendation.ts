// Recommendation Agent (SRS §6.4).
//
// Responsibility: produce the final dynamic response sections from the Profile
// Agent and Career Data Agent outputs. Two clean halves:
//   1) DB-backed sections (resources, courses, agencies) are copied DIRECTLY from
//      the Career Data Agent output — the LLM never writes these, so no link or
//      agency can be invented here. A planned-but-empty section carries an explicit
//      "no verified data" note.
//   2) Text sections (ai_suggestion, roadmap, skill_focus, next_steps) are LLM-
//      generated and grounded in the profile + memory + RAG + available links.
// Only the planned sections are produced. A roadmap not backed by a verified
// resource is flagged suggested:true (framed as general guidance, not data).
//
// The pure assembly (assembleSections) is separated from the LLM call so the
// invention-safety and section-planning guarantees can be tested deterministically
// without hitting the model.
import { z } from "zod";
import { getGroq, CHAT_MODEL } from "../../ai/client";
import { BASE_PROMPT } from "../../ai/prompt";
import { sourced } from "../sections";
import type { AgentPlan, ResponseSections, SectionName } from "../schema";
import type {
  ProfileAgentOutput,
  CareerDataAgentOutput,
  RecommendationAgentInput,
  RecommendationAgentOutput,
} from "./contracts";

// The LLM-authored text sections (all optional; only the planned ones are asked for).
const textSchema = z.object({
  ai_suggestion: z.string().optional(),
  roadmap: z.array(z.string()).optional(),
  skill_focus: z.array(z.string()).optional(),
  next_steps: z.array(z.string()).optional(),
});
export type TextSections = z.infer<typeof textSchema>;

const TEXT_SECTIONS: SectionName[] = ["ai_suggestion", "roadmap", "skill_focus", "next_steps"];

// True when any verified resource/course link was retrieved. Drives whether a
// roadmap is presented as grounded or as suggested guidance. Exported for tests.
export function hasVerifiedResources(careerData: CareerDataAgentOutput): boolean {
  return careerData.resources.length > 0 || careerData.courses.length > 0;
}

// Grounding context injected into the LLM prompt, sourced from the two upstream
// agents' outputs. The link/agency lists are explicitly framed as the ONLY ones
// the model may reference — reinforcing that verified data comes from the DB.
function buildContext(profile: ProfileAgentOutput, careerData: CareerDataAgentOutput): string {
  const parts: string[] = [`USER PROFILE:\n${profile.profileSummary}`];

  if (profile.importantConstraints.length) {
    parts.push(
      `IMPORTANT CONSTRAINTS:\n${profile.importantConstraints.map((c) => `- ${c}`).join("\n")}`
    );
  }
  if (profile.memorySummary && !profile.memorySummary.startsWith("No stored memory")) {
    parts.push(`REMEMBERED CONTEXT:\n${profile.memorySummary}`);
  }
  if (careerData.ragDocs.length) {
    parts.push(
      `RETRIEVED CAREER KNOWLEDGE:\n${careerData.ragDocs.map((d, i) => `[${i + 1}] ${d.content}`).join("\n")}`
    );
  }
  const links = [...careerData.resources, ...careerData.courses];
  if (links.length) {
    parts.push(
      `AVAILABLE RESOURCE LINKS (the ONLY links you may reference):\n${links.map((r) => `- ${r.title} (${r.url})`).join("\n")}`
    );
  }
  if (careerData.agencies.length) {
    parts.push(
      `AVAILABLE VERIFIED AGENCIES (the ONLY agencies you may reference):\n${careerData.agencies.map((a) => `- ${a.name}, ${a.location ?? ""}: ${a.services ?? ""}`).join("\n")}`
    );
  }
  return parts.length ? parts.join("\n\n") : "(no additional context available)";
}

// LLM call producing ONLY the requested text sections. Kept separate from assembly
// so assembly stays pure/testable. May throw (network/parse) — the caller catches.
// The correction brief for a regeneration pass. Rendered from the Verification
// Agent's feedback, so the second attempt is told exactly what was wrong instead
// of being asked to try again and hope.
function renderFeedback(feedback: RecommendationAgentInput["feedback"]): string {
  if (!feedback) return "";
  const parts = [
    "",
    "CORRECTION REQUIRED — your previous draft was REJECTED by verification.",
    ...(feedback.recommendedFix ? [feedback.recommendedFix] : []),
    ...(feedback.issues.length ? ["Problems found:", ...feedback.issues.map((i) => `- ${i}`)] : []),
    ...(feedback.notes ? [`Verifier notes: ${feedback.notes}`] : []),
    "Rewrite the requested sections so none of the above recurs. Keep everything else that was fine.",
  ];
  return parts.join("\n");
}

async function generateText(
  input: RecommendationAgentInput,
  wantText: SectionName[],
  resourcesAvailable: boolean
): Promise<TextSections> {
  const keys = wantText.join(", ");
  const roadmapRule = resourcesAvailable
    ? "Base the roadmap on the retrieved knowledge and available resource links."
    : "No verified roadmap resource is available, so give a general, sensible roadmap framed as suggested guidance (do not present it as verified external data).";

  const system = `${BASE_PROMPT}

You are generating a STRUCTURED response. Respond with a single JSON object containing ONLY these keys: ${keys}.
- ai_suggestion: a concise, personalized answer/recommendation grounded in the context.
- roadmap: an array of short ordered step strings. ${roadmapRule}
- skill_focus: an array of a few specific skills the user should focus on or close the gap on, informed by their profile skills vs. their goal. Each item is a short skill name with a brief qualifier (e.g. "SQL (joins, aggregation)").
- next_steps: an array of a few concrete immediate actions.
Grounding rules: use ONLY the provided context for facts. Do NOT invent agencies, courses, links, companies, salaries, or statistics. Do NOT reference any agency or link not listed in the context. Separate opinion from fact; never guarantee jobs, interviews, or salaries.`;

  const user = `User query: ${JSON.stringify(input.query)}

CONTEXT:
${buildContext(input.profile, input.careerData)}
${renderFeedback(input.feedback)}

Produce the JSON object now with only these keys: ${keys}.`;

  const completion = await getGroq().chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.3,
    max_tokens: 900,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const raw = completion.choices[0]?.message?.content ?? "";
  const parsed = textSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : {};
}

// Pure, deterministic assembly of the final sections. DB-backed sections are copied
// straight from the Career Data Agent output (so they can never be invented here);
// text sections come from the LLM output. Only planned sections are produced, in a
// stable order. Exported for tests.
export function assembleSections(
  plan: AgentPlan,
  careerData: CareerDataAgentOutput,
  text: TextSections,
  resourcesAvailable: boolean
): ResponseSections {
  const planned = plan.sections;
  const out: ResponseSections = {};

  if (planned.includes("ai_suggestion")) out.ai_suggestion = text.ai_suggestion ?? "";
  if (planned.includes("roadmap")) {
    out.roadmap = { items: text.roadmap ?? [], suggested: !resourcesAvailable };
  }
  if (planned.includes("resources")) {
    out.resources = sourced(careerData.resources, "No verified resources found for this query.");
  }
  if (planned.includes("courses")) {
    out.courses = sourced(careerData.courses, "No verified courses found for this query.");
  }
  if (planned.includes("skill_focus")) out.skill_focus = text.skill_focus ?? [];
  if (planned.includes("agencies")) {
    out.agencies = sourced(careerData.agencies, "No verified agencies found for this query.");
  }
  if (planned.includes("next_steps")) out.next_steps = text.next_steps ?? [];

  return out;
}

export async function runRecommendationAgent(
  input: RecommendationAgentInput
): Promise<RecommendationAgentOutput> {
  const planned = input.plan.sections;
  const resourcesAvailable = hasVerifiedResources(input.careerData);

  // 2) LLM text sections (only the requested ones). Fault-tolerant: on any LLM/parse
  // failure the DB-backed sections still assemble.
  const wantText = planned.filter((s) => TEXT_SECTIONS.includes(s));
  let text: TextSections = {};
  if (wantText.length > 0) {
    try {
      text = await generateText(input, wantText, resourcesAvailable);
    } catch (error) {
      console.error("Recommendation Agent text generation failed; DB sections only:", error);
    }
  }

  // 1) + assemble (pure): DB sections copied from Career Data Agent, never invented.
  const draftSections = assembleSections(input.plan, input.careerData, text, resourcesAvailable);

  return { draftSections };
}
