// Safe fallback — the terminal branch when a draft is rejected TWICE.
//
// The loop is: reject -> regenerate once with feedback -> if still rejected, stop
// trying. At that point the workflow has been told twice that it cannot write
// acceptable free text for this query, so it stops asserting and says so.
//
// What survives: the verified DB-backed sections (agencies/resources/courses).
// Those were never LLM-authored — they are copied from Career Data rows — so a
// free-text failure is no reason to withhold them.
//
// TRADE-OFF, deliberately taken: verification has ALREADY sanitized this draft,
// so the text being replaced is safe. Replacing it costs real usefulness — a
// corrected-but-useful answer becomes a generic summary. It is done because after
// two rejections the honest signal is "we could not produce grounded prose for
// this", and shipping the second gutted attempt as if it were an answer would be
// the overclaim this workflow exists to avoid. It is rare by construction: it
// needs two consecutive rejections.
//
// TWO DISTINCT FAILURES, TWO DISTINCT MESSAGES. The safe summary above is the right
// thing to say when a real draft was written twice and rejected twice — the workflow
// judged the prose and declined to stand behind it. It is the WRONG thing to say
// when no draft was ever written, which is what happens when the LLM call itself
// fails (rate limit, outage): the generator returns nothing, verification correctly
// rejects an empty answer, the retry hits the same dead provider, and the run lands
// here. Reporting that as "to keep this grounded and safe" tells the user their
// question was answered carefully when in fact it was never answered at all — and
// hides an outage behind a safety message, which is the one thing a run that exists
// to be auditable must not do.
import {
  SAFE_FALLBACK_TEXT,
  GENERATION_FAILED_TEXT,
  EMPTY_ANSWER_ISSUE,
} from "../agents/verification";
import type { ResponseSections } from "../schema";
import type { AgentStateType } from "../state";

export async function safeFallbackNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  const plan = state.plan;
  // Start from the SANITIZED sections, never the raw draft: whatever the fallback
  // keeps must still have been through the hard checks.
  const sections: ResponseSections = { ...(state.verificationResult?.finalSections ?? state.sections ?? {}) };

  // Verification already distinguished these cases; read its verdict rather than
  // re-deriving it here.
  const generationFailed = !!state.verificationResult?.issues.some((i) =>
    i.includes(EMPTY_ANSWER_ISSUE)
  );

  if (plan?.sections.includes("ai_suggestion")) {
    sections.ai_suggestion = generationFailed ? GENERATION_FAILED_TEXT : SAFE_FALLBACK_TEXT;
  } else {
    delete sections.ai_suggestion;
  }
  delete sections.roadmap;
  delete sections.skill_focus;
  delete sections.next_steps;

  return { sections };
}
