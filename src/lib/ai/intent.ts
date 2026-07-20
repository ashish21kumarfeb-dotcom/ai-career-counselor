// Thin intent-extraction slice: a cheap, separate Groq call that classifies the
// user's message into exactly one fixed label before the main answer is
// generated (MVP pipeline: input -> intent extraction -> ...). The label is
// logged to ai_recommendations.intent and will later route RAG/tools.
//
// Deliberately minimal: no RAG, memory, or agents. The call is fault-tolerant —
// any failure or unrecognized output falls back to "other" so it never breaks
// the chat request.

import { INTENT_MODEL } from "./client";
import { createCompletion } from "./usage";

// Fixed intent set. `other` is the catch-all / fallback.
export const INTENTS = [
  "career_advice",
  "skill_guidance",
  "job_search",
  "resume_help",
  "agency_search",
  "other",
] as const;

export type Intent = (typeof INTENTS)[number];

const INTENT_SET: ReadonlySet<string> = new Set(INTENTS);

const CLASSIFIER_PROMPT = `You are an intent classifier for an AI career counselor. Read the user's message and classify it into exactly one of these labels:

- career_advice: general career direction, choices, or planning questions.
- skill_guidance: what skills to learn, how to learn them, or upskilling.
- job_search: finding jobs, applications, interviews, or hiring.
- resume_help: writing, reviewing, or improving a resume or CV.
- agency_search: finding a consulting agency, recruiter, or placement service.
- other: anything that does not clearly fit the labels above.

Respond with ONLY the single label, in lowercase, and nothing else.`;

// Classify a user message into one fixed Intent. Never throws — returns "other"
// on any error or unexpected model output.
export async function classifyIntent(message: string): Promise<Intent> {
  try {
    const completion = await createCompletion("intent", {
      model: INTENT_MODEL,
      temperature: 0,
      max_tokens: 10,
      messages: [
        { role: "system", content: CLASSIFIER_PROMPT },
        { role: "user", content: message },
      ],
    });

    const raw = completion.choices[0]?.message?.content
      ?.trim()
      .toLowerCase();

    if (raw && INTENT_SET.has(raw)) {
      return raw as Intent;
    }
    return "other";
  } catch (error) {
    console.error("Intent classification failed:", error);
    return "other";
  }
}
