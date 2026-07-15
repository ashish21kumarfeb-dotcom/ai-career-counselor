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
import { SAFE_FALLBACK_TEXT } from "../agents/verification";
import type { ResponseSections } from "../schema";
import type { AgentStateType } from "../state";

export async function safeFallbackNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  const plan = state.plan;
  // Start from the SANITIZED sections, never the raw draft: whatever the fallback
  // keeps must still have been through the hard checks.
  const sections: ResponseSections = { ...(state.verificationResult?.finalSections ?? state.sections ?? {}) };

  if (plan?.sections.includes("ai_suggestion")) {
    sections.ai_suggestion = SAFE_FALLBACK_TEXT;
  } else {
    delete sections.ai_suggestion;
  }
  delete sections.roadmap;
  delete sections.skill_focus;
  delete sections.next_steps;

  return { sections };
}
