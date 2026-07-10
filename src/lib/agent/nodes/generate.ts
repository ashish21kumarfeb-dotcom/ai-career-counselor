// Generate node: builds the dynamic response. Two distinct halves so nothing gets
// invented:
//   1) DB-backed sections (agencies, resources, courses) are mapped DIRECTLY from
//      tool results — the LLM never writes these. Empty -> an explicit "no verified
//      data found" note.
//   2) Text sections (ai_suggestion, roadmap, next_steps) are LLM-generated but
//      GROUNDED in profile + memory + RAG + the retrieved resources, under the
//      shared BASE_PROMPT safety rules. A roadmap not backed by a verified
//      resource is flagged suggested:true (framed as general guidance, not data).
// Fault-tolerant: on any LLM/parse failure the DB sections still return.
import { z } from "zod";
import { getGroq, CHAT_MODEL } from "../../ai/client";
import { BASE_PROMPT } from "../../ai/prompt";
import type { RetrievedDocument } from "../../documents/queries";
import type { RetrievedAgency } from "../../agencies/queries";
import type { AgentStateType } from "../state";
import type {
  AgencyItem,
  ResourceItem,
  ResponseSections,
  SectionName,
  Sourced,
} from "../schema";

// Course-like heuristic: real course/certification providers. Deliberately narrow
// (matches provider names + "course"/"certificat") so a learning-guide URL such as
// MDN's /docs/Learn is treated as a resource, not a course.
function isCourseLike(doc: RetrievedDocument): boolean {
  const hay = `${doc.sourceUrl ?? ""} ${doc.content}`;
  return /certificat|course|coursera|udemy|freecodecamp|grow\.google|nptel|\bedx\b/i.test(hay);
}

function titleOf(content: string): string {
  const label = content.split(":")[0].trim();
  if (label && label.length <= 90) return label;
  return content.length > 90 ? `${content.slice(0, 87).trim()}...` : content.trim();
}

function toResourceItem(doc: RetrievedDocument): ResourceItem {
  return { title: titleOf(doc.content), type: doc.type, url: doc.sourceUrl };
}

function toAgencyItem(a: RetrievedAgency): AgencyItem {
  return {
    name: a.name,
    location: a.location,
    services: a.services,
    website: a.website,
    source: a.sourceUrl,
  };
}

function sourced<T>(items: T[], emptyNote: string): Sourced<T> {
  return items.length > 0 ? { items } : { items: [], note: emptyNote };
}

// Pure, LLM-free construction of the DB-backed sections. Exported for tests.
export function buildDbSections(
  sections: SectionName[],
  agencies: RetrievedAgency[],
  resourceDocs: RetrievedDocument[]
): {
  agencies?: Sourced<AgencyItem>;
  resources?: Sourced<ResourceItem>;
  courses?: Sourced<ResourceItem>;
} {
  const out: {
    agencies?: Sourced<AgencyItem>;
    resources?: Sourced<ResourceItem>;
    courses?: Sourced<ResourceItem>;
  } = {};

  if (sections.includes("agencies")) {
    out.agencies = sourced(
      agencies.map(toAgencyItem),
      "No verified agencies found for this query."
    );
  }

  const wantResources = sections.includes("resources");
  const wantCourses = sections.includes("courses");
  if (wantResources || wantCourses) {
    let resDocs = resourceDocs;
    let courseDocs = resourceDocs;
    if (wantResources && wantCourses) {
      // partition so each link appears once
      courseDocs = resourceDocs.filter(isCourseLike);
      resDocs = resourceDocs.filter((d) => !isCourseLike(d));
    } else if (wantCourses) {
      courseDocs = resourceDocs.filter(isCourseLike);
    }
    if (wantResources) {
      out.resources = sourced(
        resDocs.map(toResourceItem),
        "No verified resources found for this query."
      );
    }
    if (wantCourses) {
      out.courses = sourced(
        courseDocs.map(toResourceItem),
        "No verified courses found for this query."
      );
    }
  }

  return out;
}

const textSchema = z.object({
  ai_suggestion: z.string().optional(),
  roadmap: z.array(z.string()).optional(),
  skill_focus: z.array(z.string()).optional(),
  next_steps: z.array(z.string()).optional(),
});
type TextSections = z.infer<typeof textSchema>;

function buildContext(state: AgentStateType): string {
  const parts: string[] = [];
  const p = state.profile;
  if (p) {
    const fields = [
      `Stage: ${p.userType}`,
      p.education && `Education: ${p.education}`,
      p.currentRole && `Current role: ${p.currentRole}`,
      p.location && `Location: ${p.location}`,
      p.skills && `Skills: ${p.skills}`,
      p.interests && `Interests: ${p.interests}`,
      p.careerGoal && `Career goal: ${p.careerGoal}`,
    ].filter(Boolean);
    parts.push(`USER PROFILE:\n${fields.join("\n")}`);
  }
  if (state.memory.length) {
    parts.push(`REMEMBERED CONTEXT:\n${state.memory.map((m) => `- ${m.memoryKey}: ${m.memoryValue}`).join("\n")}`);
  }
  if (state.ragDocs.length) {
    parts.push(`RETRIEVED CAREER KNOWLEDGE:\n${state.ragDocs.map((d, i) => `[${i + 1}] ${d.content}`).join("\n")}`);
  }
  if (state.toolResults.resources.length) {
    parts.push(`AVAILABLE RESOURCE LINKS (the ONLY links you may reference):\n${state.toolResults.resources.map((d) => `- ${titleOf(d.content)} (${d.sourceUrl})`).join("\n")}`);
  }
  if (state.toolResults.agencies.length) {
    parts.push(`AVAILABLE VERIFIED AGENCIES (the ONLY agencies you may reference):\n${state.toolResults.agencies.map((a) => `- ${a.name}, ${a.location ?? ""}: ${a.services ?? ""}`).join("\n")}`);
  }
  return parts.length ? parts.join("\n\n") : "(no additional context available)";
}

async function generateText(
  state: AgentStateType,
  wantText: SectionName[],
  hasVerifiedResources: boolean
): Promise<TextSections> {
  const keys = wantText.join(", ");
  const roadmapRule = hasVerifiedResources
    ? "Base the roadmap on the retrieved knowledge and available resource links."
    : "No verified roadmap resource is available, so give a general, sensible roadmap framed as suggested guidance (do not present it as verified external data).";

  const system = `${BASE_PROMPT}

You are generating a STRUCTURED response. Respond with a single JSON object containing ONLY these keys: ${keys}.
- ai_suggestion: a concise, personalized answer/recommendation grounded in the context.
- roadmap: an array of short ordered step strings. ${roadmapRule}
- skill_focus: an array of a few specific skills the user should focus on or close the gap on, informed by their profile skills vs. their goal. Each item is a short skill name with a brief qualifier (e.g. "SQL (joins, aggregation)").
- next_steps: an array of a few concrete immediate actions.
Grounding rules: use ONLY the provided context for facts. Do NOT invent agencies, courses, links, companies, salaries, or statistics. Do NOT reference any agency or link not listed in the context. Separate opinion from fact; never guarantee jobs, interviews, or salaries.`;

  const user = `User query: ${JSON.stringify(state.query)}

CONTEXT:
${buildContext(state)}

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

export async function generateNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  const planned = state.plan?.sections ?? ["ai_suggestion"];

  // 1) DB-backed sections (no invention).
  const db = buildDbSections(planned, state.toolResults.agencies, state.toolResults.resources);

  // 2) LLM text sections (only the requested ones).
  const TEXT_SECTIONS: SectionName[] = ["ai_suggestion", "roadmap", "skill_focus", "next_steps"];
  const wantText = planned.filter((s) => TEXT_SECTIONS.includes(s));
  const hasVerifiedResources = state.toolResults.resources.length > 0;
  let text: TextSections = {};
  if (wantText.length > 0) {
    try {
      text = await generateText(state, wantText, hasVerifiedResources);
    } catch (error) {
      console.error("Generation LLM failed; returning DB sections only:", error);
    }
  }

  // 3) Assemble — only planned sections, in stable order.
  const out: ResponseSections = {};
  if (planned.includes("ai_suggestion")) out.ai_suggestion = text.ai_suggestion ?? "";
  if (planned.includes("roadmap")) out.roadmap = { items: text.roadmap ?? [], suggested: !hasVerifiedResources };
  if (planned.includes("resources")) out.resources = db.resources ?? { items: [], note: "No verified resources found for this query." };
  if (planned.includes("courses")) out.courses = db.courses ?? { items: [], note: "No verified courses found for this query." };
  if (planned.includes("skill_focus")) out.skill_focus = text.skill_focus ?? [];
  if (planned.includes("agencies")) out.agencies = db.agencies ?? { items: [], note: "No verified agencies found for this query." };
  if (planned.includes("next_steps")) out.next_steps = text.next_steps ?? [];

  return { sections: out };
}
