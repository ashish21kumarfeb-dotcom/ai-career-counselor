// Context-aware query resolution: rewrites a follow-up message into a
// self-contained, standalone question using the recent conversation, BEFORE the
// pipeline (intent -> planner -> retrieval -> generation) consumes it. Without
// this, a follow-up like "and for that role?" reaches every stage unresolved and
// planning/retrieval/answering all lose the thread.
//
// Domain-agnostic by design: the rewrite resolves ANY referential follow-up
// (pronouns, ellipsis, "that role", "the second option", "what about salary?")
// across all intents — there are no technology- or topic-specific rules.
//
// THE OPPOSITE FAILURE, and why the topic-shift layer below exists. Resolution is
// only ever correct for a message that DEPENDS on the conversation. A standalone
// question about a NEW subject ("Is there any career in fine arts?" after two turns
// about cyber security) must reach the pipeline exactly as typed. When it does not,
// the damage is silent and total: `query` is the single channel the planner, the
// retrieval tokenizer and the generator all read, so a grafted topic biases
// retrieval toward the OLD subject, the draft then asserts figures about the NEW one
// that no retrieved evidence backs, the grounding policy rejects it, the single
// regeneration hits the same contaminated context, and the run lands in
// safeFallbackNode — the user asks about fine arts and gets the generic safe
// summary. Preserving a standalone question is therefore not an optimization; it is
// the precondition for the rest of the pipeline being about the right thing.
//
// Two layers guard it, in the same shape the verification agent uses (a
// deterministic floor plus an LLM judgment), because the floor must hold precisely
// when the model is unavailable:
//   1. hasReferentialMarker + isTopicShift — pure, LLM-free, skips resolution
//      entirely for a self-contained question about words the conversation has not
//      been using.
//   2. the rewriter itself reports `topic_shift`, and any rewrite that GRAFTS
//      conversation vocabulary onto an already-self-contained question is discarded.
//
// Fault-tolerant like the intent slice: any failure, empty output, or parse error
// falls back to the ORIGINAL query, so this can never break a chat request.

import { z } from "zod";
import { REWRITE_MODEL } from "./client";
import { createCompletion } from "./usage";

// One prior turn of the active conversation, as sent by the client.
export type ChatTurn = { role: "user" | "assistant"; content: string };

// Guardrails: how much history to feed the rewriter and how much to keep per turn.
const MAX_HISTORY_TURNS = 6;
const MAX_TURN_CHARS = 500;
const MAX_REWRITE_CHARS = 500;

const REWRITE_PROMPT = `You rewrite a user's latest message into a standalone, self-contained question using the conversation so far.

Rules:
- FIRST decide whether the latest message depends on the conversation at all. If it introduces a NEW subject that the conversation has not been about, it is a topic change: set "topic_shift" to true and return the message COMPLETELY UNCHANGED. Never carry the earlier subject into a question that already names its own subject.
- Otherwise, resolve every reference (pronouns like "it/that/they", ellipsis, phrases like "that role", "the second option", "what about salary?") by SUBSTITUTING the explicit subject it refers to, drawn ONLY from the conversation. Do not merely delete the reference — replace it with the concrete topic (e.g. "that role" -> "a data scientist role").
- The rewritten question must be understandable on its own, WITHOUT the conversation, and must name the specific subject being discussed.
- Preserve the user's original intent, specifics, and language. Do not add, assume, or invent anything not present in the conversation or the message.
- If the message is already fully standalone, return it unchanged.
- Do NOT answer the question. Only rewrite it.

Example — Conversation: "User: Tell me about a career in data science. Assistant: ..." / Latest message: "What skills should I focus on for that?" -> {"query":"What skills should I focus on for a career in data science?","topic_shift":false}
Example — Conversation: "User: Cyber Security. Assistant: ... / User: Average salary in Cyber Security. Assistant: ..." / Latest message: "Is there any career in fine arts?" -> {"query":"Is there any career in fine arts?","topic_shift":true}

Respond with a single JSON object: {"query":"<the standalone question>","topic_shift":<true|false>}`;

const rewriteSchema = z.object({
  query: z.string().trim().min(1),
  topic_shift: z.boolean().optional(),
});

// Referential/elliptical markers that signal a message depends on prior turns.
// Used to SKIP the LLM when a mid-conversation message is already self-contained.
const REFERENTIAL_PATTERNS: RegExp[] = [
  // Leading conjunctions / continuations: "and ...", "also ...", "what about ...".
  /^\s*(and|also|or|but|then|so)\b/i,
  /^\s*(what|how)\s+about\b/i,
  /\bwhat\s+about\b/i,
  // Bare deictic / pronoun references. NOTE: "there" is deliberately absent — the
  // existential "is there / are there / there is" is not a reference to anything in
  // the conversation, and matching it classified every "Is there a career in X?" as
  // a follow-up, which is the exact bug this module now guards against.
  /\b(that|this|those|these|it|its|they|them|their)\b/i,
  /\b(the\s+(role|job|one|option|first|second|third|last|former|latter|company|agency|course|skill|field|area|path)s?)\b/i,
  /\b(same|above|previous|earlier|mentioned)\b/i,
];

// Does this message contain an explicit reference back into the conversation?
// Exported for tests — it is the pivot both layers below turn on.
export function hasReferentialMarker(query: string): boolean {
  return REFERENTIAL_PATTERNS.some((re) => re.test(query));
}

// --- Topic-shift detection -----------------------------------------------------
// Purely lexical and subject-agnostic: a topic shift is a question that (a) points
// at nothing in the conversation and (b) is mostly ABOUT words the conversation has
// not been using. There is no topic list, no domain taxonomy and no "career" special
// case — the same rule that separates fine arts from cyber security separates any
// new subject from any old one.
//
// The thresholds are deliberately conservative, because the two errors are not
// symmetric. Missing a shift costs a contaminated run (the bug). Wrongly calling a
// follow-up a shift costs one unresolved reference — but that only happens for a
// message carrying no referential marker at all, which is the case resolution can
// least help anyway. So: require a real sentence, several novel words, and a clear
// majority of them novel; anything short of that still goes to the LLM, which has
// its own topic_shift rule.
const MIN_SHIFT_WORDS = 5;
const MIN_NOVEL_TOKENS = 2;
const NOVELTY_THRESHOLD = 0.6;

// Function words carry no subject matter, so they must not dilute the novelty ratio
// in either direction. Nothing career- or domain-specific belongs in this list.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "as", "at", "by", "for",
  "from", "in", "into", "of", "on", "onto", "to", "with", "without", "about", "after",
  "before", "over", "under", "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "doing", "have", "has", "had", "having", "can", "could", "will",
  "would", "shall", "should", "may", "might", "must", "any", "some", "all", "each",
  "no", "not", "only", "own", "same", "so", "too", "very", "just", "how", "what",
  "when", "where", "which", "who", "whom", "why", "there", "here", "i", "me", "my",
  "mine", "we", "us", "our", "you", "your", "yours", "get", "got", "give", "make",
  "want", "need", "like", "good", "best", "better", "more", "most", "much", "many",
  "also", "please", "tell", "know", "think", "let", "s", "t",
]);

function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function historyTokens(history: ChatTurn[]): Set<string> {
  const out = new Set<string>();
  for (const turn of history.slice(-MAX_HISTORY_TURNS)) {
    for (const token of contentTokens(turn.content.slice(0, MAX_TURN_CHARS))) out.add(token);
  }
  return out;
}

function wordCount(query: string): number {
  return query.trim().split(/\s+/).filter(Boolean).length;
}

// True when `query` starts a new subject and must reach the pipeline unchanged.
// Exported for tests.
export function isTopicShift(query: string, history: ChatTurn[]): boolean {
  if (!history || history.length === 0) return false;
  // A message that points back at the conversation is a follow-up by construction,
  // however unfamiliar its other words are. This check comes first so novelty can
  // never override an explicit reference.
  if (hasReferentialMarker(query)) return false;
  if (wordCount(query) < MIN_SHIFT_WORDS) return false;

  const q = contentTokens(query);
  if (q.size === 0) return false;
  const seen = historyTokens(history);
  const novel = [...q].filter((t) => !seen.has(t));

  return novel.length >= MIN_NOVEL_TOKENS && novel.length / q.size >= NOVELTY_THRESHOLD;
}

// --- Elliptical corrections ----------------------------------------------------
// A message can depend on the conversation without pointing at it. "I mean devops
// and cloud." names its own subject and carries no pronoun, no "that", no "the
// role" — so hasReferentialMarker is false — yet it is meaningless alone: it
// RESTATES the subject of a question the user already asked, expecting the earlier
// question to be re-applied to it.
//
// Left unrecognized, such a message is longer than the short-fragment shortcut
// below and so skips resolution entirely. The consequence is not a slightly worse
// rewrite, it is a different run: `query` reaches the gates as "I mean devops and
// cloud", which matches neither RESOURCE_TERMS nor any external-tool gate in
// agent/schema.ts, so the resources/courses/skill_focus sections are gated out and
// no external search runs. The user's correction lands on the one path with the
// least context available to answer it.
//
// DELIBERATELY SEPARATE from REFERENTIAL_PATTERNS. That list is not only the
// follow-up trigger: it is also the early-return in isTopicShift and in
// graftsHistoryTopic, where a marker means "this is a follow-up by construction,
// stop guarding". Corrections must NOT get that exemption — "Actually, is there any
// career in fine arts?" is a correction in form and a topic change in substance,
// and it needs both guards live. So these patterns only ever answer the narrower
// question isLikelyFollowUp asks: is this worth sending to the resolver at all?
// The resolver's own topic_shift rule and the graft check then decide the outcome.
const CORRECTION_PATTERNS: RegExp[] = [
  // Explicit self-correction openers.
  /^\s*(i mean|i meant)\b/i,
  /^\s*(actually|instead|rather)\b/i,
  // Additive tail: "devops also", "cloud too", "kubernetes as well" — a bare
  // subject appended to whatever was being asked.
  /\b(also|too|as well)\s*[.?!]?$/i,
];

// A cheap, conservative heuristic: does this message look like a follow-up that
// needs the conversation to be understood? Very short fragments are treated as
// follow-ups too (likely elliptical). When in doubt we return true so the LLM
// still runs — correctness over the latency saving.
export function isLikelyFollowUp(query: string): boolean {
  const q = query.trim();
  if (q.length === 0) return false;
  // Short fragments are frequently elliptical/subjectless ("the roadmap?", "for
  // freshers?", "which skills matter most?") — send them to the resolver, which
  // returns them unchanged if they turn out to be standalone. Correctness over the
  // latency saving: a short genuinely-standalone question costs one no-op call.
  if (q.split(/\s+/).length <= 4) return true;
  // A correction long enough to clear the fragment shortcut but still dependent on
  // the conversation for its verb (see CORRECTION_PATTERNS above).
  if (CORRECTION_PATTERNS.some((re) => re.test(q))) return true;
  return hasReferentialMarker(q);
}

function buildHistoryBlock(history: ChatTurn[]): string {
  return history
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => {
      const who = t.role === "assistant" ? "Assistant" : "User";
      const content = t.content.trim().slice(0, MAX_TURN_CHARS);
      return `${who}: ${content}`;
    })
    .join("\n");
}

// Did the rewrite GRAFT the conversation's subject onto a question that already had
// its own? Only asked of a message with no referential marker and enough words to
// stand alone — for a short elliptical fragment ("which skills matter most?")
// importing the conversation's subject is precisely the job, so the guard must not
// apply there. Where it does apply there is nothing to resolve, so any newly
// introduced word that came from the history is contamination, not resolution.
function graftsHistoryTopic(original: string, rewritten: string, history: ChatTurn[]): boolean {
  if (hasReferentialMarker(original)) return false;
  if (wordCount(original) < MIN_SHIFT_WORDS) return false;

  const before = contentTokens(original);
  const seen = historyTokens(history);
  return [...contentTokens(rewritten)].some((t) => !before.has(t) && seen.has(t));
}

// Rewrite `query` into a standalone question given the active conversation.
// Returns the original query unchanged when there is no history, when the message
// is already self-contained, when it starts a new topic, or on any error.
export async function resolveQuery(
  query: string,
  history: ChatTurn[]
): Promise<string> {
  // First turn (or no context): nothing to resolve against — skip the LLM.
  if (!history || history.length === 0) return query;
  // Already-standalone mid-conversation messages: skip the LLM.
  if (!isLikelyFollowUp(query)) return query;
  // A new subject: resolving it against the old one is the contamination we are
  // preventing. Deterministic, so it holds even when the model is unavailable.
  if (isTopicShift(query, history)) return query;

  try {
    const completion = await createCompletion("resolve-query", {
      model: REWRITE_MODEL,
      temperature: 0,
      max_tokens: 200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: REWRITE_PROMPT },
        {
          role: "user",
          content: `Conversation so far:\n${buildHistoryBlock(history)}\n\nLatest message: ${JSON.stringify(query)}`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = rewriteSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return query;
    // The model's own verdict that this message changed the subject.
    if (parsed.data.topic_shift) return query;

    const rewritten = parsed.data.query.trim().slice(0, MAX_REWRITE_CHARS);
    if (rewritten.length === 0) return query;
    // Last line of defence: the model may report topic_shift:false and still import
    // the previous subject. Trust the rewrite only when it did not.
    if (graftsHistoryTopic(query, rewritten, history)) return query;
    return rewritten;
  } catch (error) {
    console.error("Query resolution failed; using original query:", error);
    return query;
  }
}
