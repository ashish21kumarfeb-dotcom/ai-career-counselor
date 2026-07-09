// Builds the system prompt for the career-chat slice: the counselor role, the
// safety guardrails (SRS §5.4), and the user's profile injected for
// personalization (SRS §6.1). Keep this pure and side-effect free.

// Structural type of a user_profiles row (see src/db/schema.ts). Accepting a
// structural shape avoids a hard import cycle with the queries module.
export type ProfileContext =
  | {
      userType: string;
      education: string | null;
      currentRole: string | null;
      skills: string | null;
      interests: string | null;
      careerGoal: string | null;
      location: string | null;
    }
  | undefined;

const USER_TYPE_LABELS: Record<string, string> = {
  student: "Student",
  fresher: "Fresher",
  working_professional: "Working professional",
  job_switcher: "Job switcher",
};

const BASE_PROMPT = `You are an AI Career Counselor for students, freshers, working professionals, and job switchers. Give clear, personalized, and honest career guidance.

Safety rules — always follow these:
- Never promise or guarantee jobs, interviews, or specific salaries. Real outcomes depend on the user's skills, preparation, market demand, and interview performance.
- Do not invent facts, statistics, company names, or consulting/agency names. If you are unsure, say so plainly.
- Clearly separate opinions from facts, and frame opinions as opinions.
- Be encouraging but realistic. Avoid overconfident or absolute claims.`;

// A document retrieved for RAG grounding (see src/lib/documents/queries.ts).
// Structural shape avoids importing the queries module into this pure module.
export type RetrievedSource = {
  type: string;
  content: string;
  sourceUrl: string | null;
};

// A stored memory row (see src/lib/memory/queries.ts). Structural to avoid an
// import cycle with the queries module.
export type MemoryContext = { memoryKey: string; memoryValue: string };

// Memory keys are the fixed snake_case vocabulary (see ALLOWED_MEMORY_KEYS in
// src/lib/ai/memory.ts), so render them as a readable label:
// "target_role_or_company" -> "Target role or company".
function humanizeMemoryKey(key: string): string {
  const s = key.replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}

export function buildSystemPrompt(
  profile: ProfileContext,
  sources: RetrievedSource[] = [],
  memory: MemoryContext[] = []
): string {
  let base: string;

  if (!profile) {
    base = `${BASE_PROMPT}

The user has not completed a profile yet. Ask a brief clarifying question when it would meaningfully improve your advice.`;
  } else {
    const stage = USER_TYPE_LABELS[profile.userType] ?? profile.userType;
    const fields: Array<string | null> = [
      `Stage: ${stage}`,
      profile.education ? `Education: ${profile.education}` : null,
      profile.currentRole ? `Current role: ${profile.currentRole}` : null,
      profile.location ? `Location: ${profile.location}` : null,
      profile.skills ? `Skills: ${profile.skills}` : null,
      profile.interests ? `Interests: ${profile.interests}` : null,
      profile.careerGoal ? `Career goal: ${profile.careerGoal}` : null,
    ];

    base = `${BASE_PROMPT}

Use the user's profile below to personalize your advice. Reference it naturally where relevant:
${fields.filter(Boolean).join("\n")}`;
  }

  let prompt = base;

  // Remembered context from earlier turns, injected between profile and sources.
  if (memory.length > 0) {
    const memoryBlock = memory
      .map((m) => `- ${humanizeMemoryKey(m.memoryKey)}: ${m.memoryValue}`)
      .join("\n");

    prompt += `

Remembered context from earlier conversations — treat as user-provided background. Use it where relevant and do not contradict it without good reason:
${memoryBlock}`;
  }

  if (sources.length > 0) {
    const sourceBlock = sources
      .map((s, i) => {
        const label = s.sourceUrl ? `${s.type}, ${s.sourceUrl}` : s.type;
        return `[Source ${i + 1}] (${label})\n${s.content}`;
      })
      .join("\n\n");

    prompt += `

Reference sources — the only sources you may use to support factual claims:
${sourceBlock}

Rules for using the reference sources:
- Base factual claims only on the reference sources above. Do not invent, assume, or cite any source that is not listed here.
- If the reference sources do not directly cover the user's question, say plainly that they do not directly cover it, then answer from general knowledge clearly framed as general guidance.`;
  }

  return prompt;
}
