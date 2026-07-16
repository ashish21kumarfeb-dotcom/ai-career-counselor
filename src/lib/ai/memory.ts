// Memory extraction for the chat slice (Phase 4). A separate Groq call pulls
// durable, user-stated facts from the USER's message (never the assistant's
// answer) so they can be remembered across conversations.
//
// Design goals (see the extraction rules below):
// - Store COMPLETE, self-contained facts, not fragments. Merge related details
//   from the same message (e.g. a relative "one extra month" AND an absolute
//   "within 4 months") into one meaningful memory.
// - Map every fact onto a FIXED five-key vocabulary (see ALLOWED_MEMORY_KEYS).
//   The extractor may not invent keys; anything that doesn't fit is dropped.
//   This keeps one row per (user, key) and lets upserts update in place instead
//   of accumulating timeline-like variants (project_timeline, timeline, ...).
// - Never invent or infer facts the user did not state.
//
// Two guards run after the model returns: an allowlist key check and a
// grounding check (no invented numbers/entities). Fully fault-tolerant — any
// failure or malformed output returns [] so it never breaks the chat request.

import { getGroq, CHAT_MODEL } from "./client";

// Extraction model is env-overridable. Defaults to the stronger answer model
// (llama-3.3-70b): merge-reasoning and self-containment (e.g. resolving a
// context-dependent instruction into a self-contained fact) are unreliable on
// the cheap 8B model. Runs concurrently with the answer, so no added latency.
// Set GROQ_MEMORY_MODEL to override (e.g. a cheaper model).
export const MEMORY_MODEL = process.env.GROQ_MEMORY_MODEL ?? CHAT_MODEL;

export type ExtractedMemory = { key: string; value: string };

const MAX_VALUE_LEN = 300;

// ---------------------------------------------------------------------------
// Fixed memory-key vocabulary. Every extracted fact must map onto exactly one of
// these keys; anything else is dropped. One canonical key per fact type means a
// user has at most one row per key, and upserts update it in place (no more
// project_timeline / interview_prep_timeline / timeline drift). Exported so the
// prompt renderer and tests share the single source of truth.
// ---------------------------------------------------------------------------
export const ALLOWED_MEMORY_KEYS = [
  "target_role_or_company",
  "work_preferences",
  "constraints",
  "timeline",
  "actions_taken",
] as const;

export type MemoryKey = (typeof ALLOWED_MEMORY_KEYS)[number];

const ALLOWED_KEY_SET: Set<string> = new Set(ALLOWED_MEMORY_KEYS);

// Allowlist check: a key is valid only if it is exactly one of the fixed keys.
// Exported for tests.
export function isValidMemoryKey(key: string): boolean {
  return ALLOWED_KEY_SET.has(key);
}

const EXTRACTOR_PROMPT = `You extract durable, reusable facts about the user from THEIR latest message in a career-counseling chat, so they can be remembered in future conversations.

OUTPUT: a JSON array (no prose, no code fences) of objects {"key": "<one of the allowed keys>", "value": "<complete self-contained fact>"}. Return [] if the message states no durable fact that maps to an allowed key.

ALLOWED KEYS — you MUST use one of these exactly, and NOTHING else:
- "target_role_or_company": the role, job title, field, or company the user is aiming for or switching into.
- "work_preferences": stable preferences about how they work, learn, or want things done (e.g. learning style, remote/onsite, tech stack or tool choices, explanation style).
- "constraints": limits or hard requirements (e.g. location/relocation limits, salary floor, availability, visa, family or health constraints).
- "timeline": ANY time-related fact — deadlines, timeframes, prep schedules, project timelines, interview timelines, "within N months", "starting next week". ALL of these map to "timeline".
- "actions_taken": concrete steps the user has done or is actively doing (e.g. applied to X, started a course, built a project, scheduled an interview).

KEY RULES (strict):
- DO NOT invent new keys. Use ONLY the five allowed keys above.
- Every time/deadline/timeframe/project-timeline/interview-timeline fact maps to "timeline" — never a variant like project_timeline or interview_prep_timeline.
- If a fact does not clearly fit one of the allowed keys, DROP it. If none of the message fits, return [].
- At most one object per key. If a message has several details for the same key, MERGE them into that key's single value.

CAPTURE (durable, useful later): career targets, learning/work preferences, tool or stack choices, constraints, timelines, and concrete actions taken. A tentative direction still counts if durable (e.g. "I may switch jobs soon" -> target_role_or_company, as stated, without adding specifics).
DO NOT CAPTURE: greetings, thanks, acknowledgements, one-off questions, or anything temporary or trivial.

WRITING THE VALUE:
- Make it a COMPLETE fact, not a fragment. If the message states several related details for the same key, MERGE them into one meaningful sentence.
- Keep BOTH relative and absolute values when both are given (e.g. "one extra month" AND "within 4 months total" — keep both).
- Make it SELF-CONTAINED: it must make sense later without the earlier conversation. Resolve references like "this topic" or "that role" into explicit terms, using only what is explicit.
- Write clear, natural language (e.g. "User prefers ...", "User plans to ...").
- Include EVERY explicit durable detail from the message. Do not drop any.

STRICT — NO INVENTION:
- Use ONLY facts explicitly stated by the user (or explicitly resolved from the current message).
- Never infer, guess, add, or fill in missing details (no invented role, company, salary, number, or timeline).
- If a detail was not stated, leave it out.

BEFORE OUTPUT, validate each memory and revise or drop any that fails:
1. Is the key EXACTLY one of the five allowed keys? If not, drop it.
2. Is it self-contained without prior context?
3. Did you include every explicit value from the message (both relative and absolute)?
4. Did you invent anything not stated? If yes, remove it.
5. Is it genuinely durable? If not, drop it.

EXAMPLES (patterns, not templates):
Message: "I'll add two more weeks of practice, so I should be ready in about 2 months."
-> [{"key":"timeline","value":"User will add two extra weeks of practice and expects to be ready in about 2 months total."}]
Message: "Going forward, explain things using diagrams."
-> [{"key":"work_preferences","value":"User prefers explanations that use diagrams."}]
Message: "From now on, explain this topic with real project examples."
-> [{"key":"work_preferences","value":"User prefers explanations that use real project examples."}]
Message: "I'm leaning towards backend roles."
-> [{"key":"target_role_or_company","value":"User is leaning towards backend roles."}]
Message: "I can't relocate out of Pune."
-> [{"key":"constraints","value":"User cannot relocate out of Pune."}]
Message: "I applied to three product companies last week."
-> [{"key":"actions_taken","value":"User applied to three product companies last week."}]
Message: "Cool, I'll check it later."
-> []`;

// ---------------------------------------------------------------------------
// Grounding: reject invented values without punishing natural paraphrase.
//  - number guard: every number in the value must appear in the message.
//  - content guard: after stripping framing words, most of the value's
//    meaningful terms must appear in the message (prefix-matched).
// Exported for tests.
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  "the", "and", "for", "with", "into", "from", "that", "this", "than", "then",
  "are", "was", "were", "been", "has", "have", "not", "but", "any", "all",
  "some", "who", "why", "when", "where", "which", "about", "out", "off",
]);

// Meta/framing words that describe a fact rather than being the fact. Stripped
// before the content check so self-contained phrasing ("User plans to ...")
// isn't penalised.
const FRAMING_WORDS = new Set([
  "user", "users", "plan", "plans", "planning", "planned", "want", "wants",
  "wanting", "wanted", "prefer", "prefers", "preferring", "preferred",
  "preference", "intend", "intends", "intending", "will", "would", "going",
  "currently", "total", "overall", "generally", "like", "likes", "need",
  "needs", "hope", "hopes", "aim", "aims", "expect", "expects", "looking",
  "looks", "more",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function significantTokens(text: string): string[] {
  return tokenize(text).filter((w) => !FRAMING_WORDS.has(w));
}

function numberTokens(text: string): string[] {
  return text.match(/\d+/g) ?? [];
}

const GROUNDING_MIN_OVERLAP = 0.6;

export function isGrounded(value: string, message: string): boolean {
  // Number guard: no invented numbers (wrong/hallucinated timelines, salaries…).
  const messageNumbers = new Set(numberTokens(message));
  for (const n of numberTokens(value)) {
    if (!messageNumbers.has(n)) return false;
  }

  // Content guard: meaningful terms must be supported by the message.
  const valueSig = significantTokens(value);
  if (valueSig.length === 0) return true; // pure framing; number guard already ran

  const messageSig = significantTokens(message);
  const exact = new Set(messageSig);
  const prefixes = new Set(messageSig.filter((w) => w.length >= 4).map((w) => w.slice(0, 4)));

  const supported = valueSig.filter(
    (t) => exact.has(t) || (t.length >= 4 && prefixes.has(t.slice(0, 4)))
  ).length;

  return supported / valueSig.length >= GROUNDING_MIN_OVERLAP;
}

function tryParse(text: string): unknown[] | null {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    // Tolerate a wrapper object like { "facts": [...] }.
    if (parsed && Array.isArray((parsed as { facts?: unknown }).facts)) {
      return (parsed as { facts: unknown[] }).facts;
    }
    return null;
  } catch {
    return null;
  }
}

// Robust parse: small models sometimes wrap the JSON in code fences or prefix it
// with prose ("Let's extract..."). Never throws — returns [] if no array found.
function parseFacts(raw: string): unknown[] {
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  }
  const direct = tryParse(s);
  if (direct) return direct;

  // Fall back to the first bracketed array anywhere in the text.
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start !== -1 && end > start) {
    const sliced = tryParse(s.slice(start, end + 1));
    if (sliced) return sliced;
  }
  return [];
}

// Extract durable facts from a user message. Never throws — returns [] on any
// error, malformed output, or when nothing durable was stated. Applies the key
// and grounding guards, logging every dropped candidate for debugging, and
// deduplicates by key (last value wins) so a batch upsert can't hit the same
// key twice.
// The extractor's outcome, not just its output.
//
// `available: false` means the extractor could not RUN (LLM error) — it does NOT
// mean the user stated nothing. Both previously collapsed to `[]`, so a caller
// could not tell "nothing durable was said" from "we have no idea", and the run
// trace reported a rate-limited extraction as a successful one.
//
// Same distinction, and the same reason, as SoftCheckResult.available in the
// Verification Agent: an unavailable check must never read as a negative result.
export type MemoryExtraction = {
  facts: ExtractedMemory[];
  available: boolean;
  error?: string;
};

// Back-compat wrapper: callers that only want the facts (and treat a failure as
// "no facts") keep working unchanged. New callers that need to report honestly
// should use extractMemoriesDetailed.
export async function extractMemories(
  message: string
): Promise<ExtractedMemory[]> {
  return (await extractMemoriesDetailed(message)).facts;
}

export async function extractMemoriesDetailed(
  message: string
): Promise<MemoryExtraction> {
  try {
    const completion = await getGroq().chat.completions.create({
      model: MEMORY_MODEL,
      temperature: 0,
      max_tokens: 400,
      messages: [
        { role: "system", content: EXTRACTOR_PROMPT },
        { role: "user", content: message },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    const items = parseFacts(raw);

    const byKey = new Map<string, string>();
    for (const item of items) {
      const rawKey = (item as { key?: unknown }).key;
      const rawValue = (item as { value?: unknown }).value;
      if (typeof rawKey !== "string" || typeof rawValue !== "string") continue;

      const key = rawKey.trim().toLowerCase();
      const value = rawValue.trim().slice(0, MAX_VALUE_LEN);
      if (!value) continue;

      if (!isValidMemoryKey(key)) {
        console.warn(
          `Dropped memory (key not in allowed vocabulary): ${key}="${value}"`
        );
        continue;
      }

      if (!isGrounded(value, message)) {
        console.warn(
          `Dropped ungrounded memory: ${key}="${value}" (not supported by user message)`
        );
        continue;
      }

      byKey.set(key, value); // last wins
    }

    // An empty result here is a real answer: the message stated nothing durable.
    return { facts: Array.from(byKey, ([key, value]) => ({ key, value })), available: true };
  } catch (error) {
    console.error("Memory extraction failed:", error);
    return {
      facts: [],
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
