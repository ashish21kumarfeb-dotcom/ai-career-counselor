// Structured intent + slot extraction: one JSON-mode Groq call that replaces the
// single-label classifier as the graph's intent stage. Same 7-label vocabulary
// (the label is persisted to varchar columns and shown in the UI, so it must not
// change shape); the slots are NEW, additive signal that downstream consumers —
// the planner prompt, the search strategy, and eventually the lane gates via
// lanes.ts — can act on deterministically.
//
// Fault-tolerant like classifyIntent: any LLM/parse/validation failure returns
// { intent: "other", slots: EMPTY_SLOTS, degraded: true } so the request never
// breaks and consumers know to fall back to the regex gates.
import { z } from "zod";
import { INTENT_MODEL } from "./client";
import { createCompletion } from "./usage";
import { INTENTS, type Intent } from "./intent";

// Every field carries a default: the small extraction model routinely OMITS a
// slot instead of sending null, and an omitted slot means "not stated" — the
// same thing the default expresses. A wrong TYPE (role: 42) still fails
// validation and degrades the whole extraction; only absence is forgiven.
export const intentSlotsSchema = z.object({
  // Entity slots — null when not stated (the prompt forbids guessing).
  role: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
  industry: z.string().nullable().default(null),
  seniority: z.string().nullable().default(null),
  company: z.string().nullable().default(null),
  skills: z.array(z.string()).default([]),
  // Behavioural slots — what kind of answer the user wants.
  hiring: z.boolean().default(false), // wants live hiring activity / company lists
  wantsProvider: z.boolean().default(false), // asks for a HUMAN counsellor/agency/recruiter
  wantsFacts: z.boolean().default(false), // needs a current fact (salary, openings, stats)
  freshness: z.enum(["none", "evergreen", "recent", "breaking"]).default("none"),
});
export type IntentSlots = z.infer<typeof intentSlotsSchema>;

export const EMPTY_SLOTS: IntentSlots = Object.freeze({
  role: null,
  location: null,
  industry: null,
  seniority: null,
  company: null,
  skills: [],
  hiring: false,
  wantsProvider: false,
  wantsFacts: false,
  freshness: "none",
});

export type IntentExtraction = {
  intent: Intent;
  slots: IntentSlots;
  // True when the LLM/parse failed and the defaults above were used — the signal
  // for consumers to fall back to the regex gates.
  degraded: boolean;
};

const INTENT_SET: ReadonlySet<string> = new Set(INTENTS);

const EXTRACTOR_PROMPT = `You are an intent and slot extractor for an AI career counselor. Read the user's message and respond with ONLY a JSON object of this exact shape:
{"intent":"...","role":null,"location":null,"industry":null,"seniority":null,"company":null,"skills":[],"hiring":false,"wantsProvider":false,"wantsFacts":false,"freshness":"none"}

intent — exactly one of:
- career_advice: general career direction, choices, or planning questions.
- skill_guidance: what skills to learn, how to learn them, or upskilling.
- job_search: finding jobs, applications, interviews, or hiring.
- resume_help: writing, reviewing, or improving a resume or CV.
- agency_search: finding a consulting agency, recruiter, or placement service.
- company_discovery: finding real companies/firms/startups/employers that are hiring or match a criterion, usually by role and/or location.
- other: anything that does not clearly fit the labels above.

Slots — extract ONLY what the message states; use null / [] / false when not stated. NEVER guess.
- role: the job role or title discussed (e.g. "devops engineer").
- location: the city/region/country named.
- industry: the industry or sector named.
- seniority: the experience level stated (e.g. "fresher", "senior").
- company: a specific company named.
- skills: specific skills, tools, or technologies mentioned.
- hiring: true if the user wants live hiring activity or a list of companies that are hiring.
- wantsProvider: true if the user asks for a HUMAN provider — counsellor, consultant, mentor, coach, agency, recruiter, or placement service.
- wantsFacts: true if answering needs a current fact about the world — a salary figure, opening count, statistic, growth rate.
- freshness: "breaking" for explicit news/very-recent events (layoffs, announcements); "recent" for latest/current/this-year phrasing; "evergreen" for timeless how-to questions; "none" when time does not matter.`;

// Extract intent + slots from a user message. Never throws.
export async function extractIntent(message: string): Promise<IntentExtraction> {
  try {
    const completion = await createCompletion("intent", {
      model: INTENT_MODEL,
      temperature: 0,
      max_tokens: 350,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EXTRACTOR_PROMPT },
        { role: "user", content: message },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    return parseExtraction(raw);
  } catch (error) {
    console.error("Intent extraction failed:", error);
    return { intent: "other", slots: EMPTY_SLOTS, degraded: true };
  }
}

// Parse + validate a raw completion. Split out (and exported) so the fallback
// behaviour is unit-testable without a network call.
export function parseExtraction(raw: string): IntentExtraction {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const { intent: rawIntent, ...slotFields } = obj;
    const slots = intentSlotsSchema.parse(slotFields);
    // An off-list label degrades the LABEL only — valid slots are still worth
    // keeping, and they are what downstream consumers act on.
    const label = typeof rawIntent === "string" ? rawIntent.trim().toLowerCase() : "";
    const intent: Intent = INTENT_SET.has(label) ? (label as Intent) : "other";
    return { intent, slots, degraded: false };
  } catch (error) {
    console.error("Intent extraction output invalid:", error);
    return { intent: "other", slots: EMPTY_SLOTS, degraded: true };
  }
}
