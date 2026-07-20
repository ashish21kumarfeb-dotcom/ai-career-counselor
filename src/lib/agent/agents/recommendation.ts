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
import { factualDataGate } from "../schema";
import type { AgentPlan, ResponseSections, SectionName } from "../schema";
import type {
  ProfileAgentOutput,
  CareerDataAgentOutput,
  ExternalResult,
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

// Per-key prompt spec. Only the PLANNED keys are described and only their shapes
// are shown, so the model is never told about a section it must not emit — an
// earlier version described all four keys every time, which is what nudged the
// model to answer a single-key ai_suggestion plan with a nested object holding
// roadmap/skill_focus/next_steps inside it.
const KEY_SPECS: Record<string, { shape: string; desc: string }> = {
  ai_suggestion: {
    shape: `"ai_suggestion": "<one plain-text answer, no nested object, no markdown headings>"`,
    desc: "ai_suggestion: a concise, personalized answer/recommendation grounded in the context, written as ONE plain string. If a roadmap, skills, or next steps are relevant, fold them into that prose — do NOT emit them as separate keys or as a nested object.",
  },
  roadmap: {
    shape: `"roadmap": ["<step 1>", "<step 2>"]`,
    desc: "roadmap: a flat array of short ordered step strings.",
  },
  skill_focus: {
    shape: `"skill_focus": ["<skill (qualifier)>"]`,
    desc: 'skill_focus: a flat array of a few specific skills the user should focus on or close the gap on, informed by their profile skills vs. their goal. Each item is a short skill name with a brief qualifier (e.g. "SQL (joins, aggregation)").',
  },
  next_steps: {
    shape: `"next_steps": ["<concrete action>"]`,
    desc: "next_steps: a flat array of a few concrete immediate actions.",
  },
};

// True when any verified resource/course link was retrieved. Drives whether a
// roadmap is presented as grounded or as suggested guidance. Exported for tests.
export function hasVerifiedResources(careerData: CareerDataAgentOutput): boolean {
  return careerData.resources.length > 0 || careerData.courses.length > 0;
}

// The external (Tavily) sourced results carried on the Career Data envelope, in a
// stable lane order. These come from web search, not the DB, so — unlike agencies
// and resource links, which render as their own verified sections — they ground the
// FREE TEXT: the model may cite them for the roadmap, market context, and next
// steps. Every one carries an http url (the sourced-only invariant), so citing one
// is genuine grounding, not invention.
function externalReferences(
  careerData: CareerDataAgentOutput
): { label: string; rows: ExternalResult[] }[] {
  return [
    { label: "Career roadmaps", rows: careerData.roadmaps ?? [] },
    { label: "Labor-market signals", rows: careerData.marketSignals ?? [] },
    { label: "Industry articles", rows: careerData.industryArticles ?? [] },
  ].filter((lane) => lane.rows.length > 0);
}

// --- Evidence posture ---------------------------------------------------------
// Whether this turn is answerable from model knowledge at all, and whether the
// retrieval actually delivered. Two independent facts, so the three cases stay
// distinguishable: advice question (grounding rules as before), factual question
// WITH evidence (evidence is mandatory, model knowledge is not admissible), and
// factual question WITHOUT evidence (say so — do not improvise a figure, and do not
// pad the gap with generic advice pretending to be an answer).

// True when any external (web-sourced) result reached the envelope. DB resource and
// agency rows are deliberately NOT counted: a course link is not evidence for what a
// role pays. Exported for tests.
export function hasExternalEvidence(careerData: CareerDataAgentOutput): boolean {
  return (
    (careerData.roadmaps?.length ?? 0) > 0 ||
    (careerData.marketSignals?.length ?? 0) > 0 ||
    (careerData.industryArticles?.length ?? 0) > 0
  );
}

export interface EvidencePosture {
  // The query asks for a current fact about the world (pay, demand, counts, rates).
  required: boolean;
  // Retrieval produced something citable for it (external results or RAG docs).
  available: boolean;
}

export function evidencePosture(
  query: string,
  careerData: CareerDataAgentOutput
): EvidencePosture {
  return {
    required: factualDataGate(query),
    available: hasExternalEvidence(careerData) || careerData.ragDocs.length > 0,
  };
}

// The prompt clause that encodes the posture. Split out from the system prompt so
// each branch's exact wording is unit-testable without an LLM.
//
// The unevidenced branch deliberately CONTRADICTS the general "do not refuse to
// advise just because a figure is unavailable" rule, and says so in the prompt. That
// rule is right for an advice question that happens to touch a number; it is wrong
// for a question whose entire content IS the number, where "advise anyway" is what
// produced the generic non-answer this posture exists to prevent.
export function evidenceDirective(posture: EvidencePosture): string {
  if (!posture.required) {
    return `Numbers rule: any salary, percentage, growth rate, hiring count, ranking or timeline stated as FACT must appear in the provided context. If the context does not contain it, either leave the figure out and answer qualitatively, or keep the guidance and mark it explicitly as an unverified estimate (e.g. "this varies widely and I don't have verified figures for your market"). An honest answer without a number is better than a number you cannot source — but do NOT refuse to advise just because a figure is unavailable.`;
  }
  if (posture.available) {
    return `EVIDENCE-FIRST (this question asks for current factual market information):
- Every factual claim — pay, demand, hiring levels, openings, growth, rankings, timelines, industry statistics — must come from the RETRIEVED CAREER KNOWLEDGE or EXTERNAL SOURCED REFERENCES above, and must be attributed to its source by name (e.g. "according to <source>").
- Your own background knowledge is NOT an admissible source for these claims. If you know a figure but it is not in the context, it does not go in the answer.
- Where the retrieved sources disagree or give a range, report the range and say the sources vary rather than picking one number.
- If a specific part of the question is not covered by the retrieved sources, say plainly that you have no verified data for that part. Answer the parts that ARE covered.`;
  }
  return `NO VERIFIED DATA (this question asks for current factual market information, and retrieval returned no usable sources):
- State clearly and early that you do not have verified data for this question — for example: "I don't have verified data on this right now, so I can't give you figures I can stand behind."
- Do NOT state, estimate, approximate, or imply any specific figure: no salary, range, percentage, growth rate, opening count, ranking, or timeline. Not from memory, not "roughly", not "typically around".
- Do NOT name any company, report, survey, or publication as a source — none were retrieved.
- Do NOT pad the gap with generic career advice presented as if it answered the question.
- DO be useful within that limit: say briefly what would answer it (official labour statistics for their country, pay-benchmark sites, current job postings in their location) and offer to help with the parts of their situation you can address from their profile. Keep it short.
- This instruction OVERRIDES the general guidance about still advising when a figure is unavailable. For this question the figure IS the answer, so an honest "no verified data" is the correct response.`;
}

// Keep a provider snippet from ballooning the prompt while still giving the model
// enough to ground a sentence.
function clip(text: string, max = 220): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

// Grounding context injected into the LLM prompt, sourced from the two upstream
// agents' outputs. The link/agency lists are explicitly framed as the ONLY ones
// the model may reference — reinforcing that verified data comes from the DB. The
// external sourced references are added the same way: citable, but nothing beyond
// them may be introduced. Exported so the injection is unit-testable without an LLM.
export function buildContext(profile: ProfileAgentOutput, careerData: CareerDataAgentOutput): string {
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
  const external = externalReferences(careerData);
  if (external.length) {
    const lanes = external
      .map(
        ({ label, rows }) =>
          `${label}:\n${rows
            .map((e) => `- ${e.title} — ${e.source} (${e.url})${e.snippet ? `: ${clip(e.snippet)}` : ""}`)
            .join("\n")}`
      )
      .join("\n");
    parts.push(
      `EXTERNAL SOURCED REFERENCES (retrieved via web search — you MAY cite these to ground the roadmap, market context, and next steps; reference them by their source name or link. Do NOT introduce any company, statistic, salary, or source that is not listed here or above):\n${lanes}`
    );
  }
  // What retrieval tried and did not find. Without this the model sees only silence
  // where a lane came back empty, and silence is indistinguishable from "not looked
  // for" — which is how an unanswerable factual question turns into a confident one.
  // Stating the miss explicitly is also what lets the answer name the gap accurately.
  if (careerData.missingDataNotes.length) {
    parts.push(
      `RETRIEVAL STATUS (searched and NOT found — treat these as gaps in the evidence, never as facts to fill in):\n${careerData.missingDataNotes
        .map((n) => `- ${n}`)
        .join("\n")}`
    );
  }
  return parts.length ? parts.join("\n\n") : "(no additional context available)";
}

// --- Tolerant parsing of the model's JSON ------------------------------------
// The model occasionally deviates from the requested shape in two predictable
// ways: it wraps the whole answer in an envelope ({"response": {...}}), or it
// packs the other text sections INSIDE the one key it was asked for
// ({"ai_suggestion": {"roadmap": [...], "next_steps": [...]}}). A strict parse
// turned both into `{}`, which surfaced as an empty answer and the generic safe
// fallback. These repairs recover the content; anything still unrecoverable is
// logged with the offending payload rather than silently dropped.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Flatten a value into a single plain-text string.
function toText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(" ");
  if (isPlainObject(value)) {
    return Object.values(value).map(toText).filter(Boolean).join(" ");
  }
  return "";
}

// Flatten a value into an array of short strings. Handles the model returning a
// single string, or objects like {step: "..."} / {title: "...", detail: "..."}.
function toList(value: unknown): string[] {
  if (typeof value === "string") {
    const t = value.trim();
    return t ? [t] : [];
  }
  if (Array.isArray(value)) return value.flatMap(toList);
  if (isPlainObject(value)) {
    const item = toText(value);
    return item ? [item] : [];
  }
  return [];
}

// Collect every occurrence of the known text keys from the payload, descending
// through wrapper objects and through a requested key whose value is itself an
// object of text keys. Bounded depth so a pathological payload cannot loop.
function collectKeys(node: unknown, out: Record<string, unknown[]>, depth = 0): void {
  if (depth > 3 || !isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (TEXT_SECTIONS.includes(key as SectionName)) {
      // A key holding a nested object of OTHER text keys is a mis-shaped answer:
      // record it as a candidate for itself, and also descend for the siblings.
      (out[key] ??= []).push(value);
      if (isPlainObject(value)) collectKeys(value, out, depth + 1);
    } else {
      collectKeys(value, out, depth + 1);
    }
  }
}

// Turn a raw parsed payload into the requested text sections, dropping anything
// the planner did not ask for. Pure — exported so the repairs are testable
// without an LLM.
export function coerceTextSections(raw: unknown, wantText: SectionName[]): TextSections {
  const found: Record<string, unknown[]> = {};
  collectKeys(raw, found);

  const out: TextSections = {};
  for (const key of wantText) {
    const candidates = found[key] ?? [];
    if (key === "ai_suggestion") {
      // Prefer a genuine string; fall back to flattening a nested object so a
      // mis-shaped answer still yields prose instead of nothing.
      const direct = candidates.find((c) => typeof c === "string" && c.trim());
      const text = typeof direct === "string" ? direct.trim() : toText(candidates[0]);
      if (text) out.ai_suggestion = text;
    } else {
      const items = candidates.flatMap(toList);
      if (items.length) out[key as "roadmap" | "skill_focus" | "next_steps"] = items;
    }
  }
  return out;
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
  const posture = evidencePosture(input.query, input.careerData);
  const roadmapRule = resourcesAvailable
    ? "Base the roadmap on the retrieved knowledge and available resource links."
    : "No verified roadmap resource is available, so give a general, sensible roadmap framed as suggested guidance (do not present it as verified external data).";

  // Describe and show ONLY the requested keys — never the others.
  const specs = wantText.map((k) => KEY_SPECS[k]).filter(Boolean);
  const shape = `{\n${specs.map((s) => `  ${s.shape}`).join(",\n")}\n}`;
  const descriptions = wantText
    .map((k) => {
      const desc = KEY_SPECS[k]?.desc ?? "";
      return `- ${k === "roadmap" ? `${desc} ${roadmapRule}` : desc}`;
    })
    .join("\n");
  const omitted = TEXT_SECTIONS.filter((s) => !wantText.includes(s));

  const system = `${BASE_PROMPT}

You are generating a STRUCTURED response. Respond with a single JSON object whose TOP-LEVEL keys are EXACTLY these and nothing else: ${keys}.

Required shape (match the types exactly):
${shape}

${descriptions}

Output rules (strict):
- Emit exactly the ${wantText.length} key(s) listed above at the top level. No extra keys.${omitted.length ? ` In particular do NOT emit ${omitted.join(", ")} — not at the top level and not nested inside another key's value.` : ""}
- Do NOT wrap the object in another object (no "response", "result", or "output" envelope).
- Every value must be exactly the type shown above: a string stays a string, an array stays a flat array of strings. Never put an object where a string or a string array is required.
Grounding rules: use ONLY the provided context for facts. Do NOT invent agencies, courses, links, companies, salaries, or statistics. You MAY cite a figure, trend, or source ONLY if it appears in the provided context (including the EXTERNAL SOURCED REFERENCES), and you must attribute it to that source. Do NOT reference any agency, link, or source not listed in the context. Separate opinion from fact; never guarantee jobs, interviews, or salaries.
${evidenceDirective(posture)}`;

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

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    console.error(
      "[recommendation] model returned non-JSON; dropping text sections.",
      { wantText, error, raw: clip(raw, 500) }
    );
    return {};
  }

  // Strict first: an on-spec answer parses unchanged, preserving existing behavior.
  const strict = textSchema.safeParse(payload);
  if (strict.success) {
    // Still drop anything unrequested, so a stray key never reaches the response.
    const kept: TextSections = {};
    for (const key of wantText) {
      const value = strict.data[key as keyof TextSections];
      if (value !== undefined) (kept as Record<string, unknown>)[key] = value;
    }
    if (wantText.some((k) => kept[k as keyof TextSections] === undefined)) {
      console.warn("[recommendation] model omitted requested key(s).", {
        wantText,
        returned: Object.keys(kept),
      });
    }
    return kept;
  }

  // Off-spec (the common case: sections nested under a single requested key, or
  // an envelope). Repair rather than silently returning {} — and log what was wrong.
  const repaired = coerceTextSections(payload, wantText);
  const recovered = Object.keys(repaired);
  console.warn(
    "[recommendation] model output did not match the requested schema; repaired.",
    {
      wantText,
      issues: strict.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      recovered,
      raw: clip(raw, 500),
    }
  );
  if (recovered.length === 0) {
    console.error(
      "[recommendation] unrepairable model output; no text sections produced.",
      { wantText, raw: clip(raw, 500) }
    );
  }
  return repaired;
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
