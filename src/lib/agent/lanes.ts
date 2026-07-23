// Lane derivation — the single place that decides WHICH retrieval lanes a query
// earns, expressed over two independent signal sources:
//
//   deriveLanesFromRegex(query)        — the six existing deterministic gates
//                                        (schema.ts), verbatim. Today's behavior.
//   deriveLanesFromSlots(slots, intent)— the same decisions derived from the
//                                        structured extraction (extractIntent).
//   resolveLanes(query, extraction?)   — the composition rule: slots primary,
//                                        regex fallback, with two hard
//                                        invariants (below).
//
// INVARIANTS, non-negotiable:
//   1. The agencies lane can never be WIDER than agencyGate(query). Agencies are
//      the sensitive DB-only section; the regex veto is fail-closed and an LLM
//      extraction must not be able to open it. Slots may only narrow it.
//   2. A degraded/absent extraction falls back to the regex gates verbatim, so
//      the pipeline never behaves worse than today when the extractor is down.
//
// ROLLOUT: currently used in SHADOW mode only — the intent stage records both
// derivations and whether they agree (trace detail), while careerData.ts and
// plan/finalize.ts keep calling the regex gates directly. Once shadow data shows
// agreement, both switch to resolveLanes (with orWithRegex as the transition
// flag) and this module becomes the single source of truth, fixing the current
// duplication between the retrieval boundary and deriveTools().
import {
  agencyGate,
  resourceGate,
  careerRoadmapGate,
  marketSignalGate,
  industryArticleGate,
  liveBusinessGate,
} from "./schema";
import type { Intent } from "../ai/intent";
import type { IntentExtraction, IntentSlots } from "../ai/extractIntent";

export type LaneDecisions = {
  agencies: boolean;
  resources: boolean;
  roadmaps: boolean;
  market: boolean;
  articles: boolean;
  hiring: boolean;
};

// The six existing gates, verbatim, as one record. Pure.
export function deriveLanesFromRegex(query: string): LaneDecisions {
  return {
    agencies: agencyGate(query),
    resources: resourceGate(query),
    roadmaps: careerRoadmapGate(query),
    market: marketSignalGate(query),
    articles: industryArticleGate(query),
    hiring: liveBusinessGate(query),
  };
}

// The same decisions from slots. Pure; mirrors the regex gates' semantics:
//  - hiring          <- the hiring slot (liveBusinessGate's job).
//  - agencies        <- wantsProvider. (The live-business veto that keeps a
//                       hiring query off the curated DB list is enforced in
//                       resolveLanes via the agencyGate AND — invariant 1.)
//  - market/articles <- wantsFacts (factualDataGate's job) or freshness, with
//                       the company-discovery suppression: a pure entity-
//                       discovery query (hiring, no facts wanted) gets the
//                       Hiring Companies answer alone.
//  - roadmaps        <- learning-shaped intents, or named skills to close.
//  - resources       <- same learning signal (resources/courses share a tool).
export function deriveLanesFromSlots(slots: IntentSlots, intent: Intent): LaneDecisions {
  const learning =
    intent === "skill_guidance" ||
    slots.skills.length > 0 ||
    (intent === "career_advice" && slots.role !== null);
  const discoveryOnly = slots.hiring && !slots.wantsFacts;
  return {
    agencies: slots.wantsProvider,
    resources: learning,
    roadmaps: learning,
    market: !discoveryOnly && (slots.wantsFacts || slots.freshness === "breaking"),
    articles:
      !discoveryOnly &&
      (slots.wantsFacts || slots.freshness === "recent" || slots.freshness === "breaking"),
    hiring: slots.hiring || intent === "company_discovery",
  };
}

// The composition rule. `orWithRegex` is the transition flag: while true (the
// default), every lane a regex gate would open stays open, so switching callers
// to resolveLanes can never silently LOSE recall — slots only add. Set false
// only after shadow data has earned it (v3).
export function resolveLanes(
  query: string,
  extraction?: IntentExtraction,
  opts: { orWithRegex?: boolean } = {}
): LaneDecisions {
  const regex = deriveLanesFromRegex(query);
  if (!extraction || extraction.degraded) return regex;

  const orWithRegex = opts.orWithRegex ?? true;
  const slots = deriveLanesFromSlots(extraction.slots, extraction.intent);
  const merged: LaneDecisions = orWithRegex
    ? {
        agencies: slots.agencies || regex.agencies,
        resources: slots.resources || regex.resources,
        roadmaps: slots.roadmaps || regex.roadmaps,
        market: slots.market || regex.market,
        articles: slots.articles || regex.articles,
        hiring: slots.hiring || regex.hiring,
      }
    : slots;

  // Invariant 1: slots never widen the sensitive agencies lane past its
  // fail-closed regex veto.
  merged.agencies = merged.agencies && agencyGate(query);
  return merged;
}

// Shadow-mode comparison for the trace: both derivations plus whether they
// agree, so the rollout decision is made on recorded data instead of vibes.
export function shadowCompare(
  query: string,
  extraction: IntentExtraction
): { slotLanes: LaneDecisions; regexLanes: LaneDecisions; agree: boolean } {
  const slotLanes = deriveLanesFromSlots(extraction.slots, extraction.intent);
  const regexLanes = deriveLanesFromRegex(query);
  const agree = (Object.keys(regexLanes) as Array<keyof LaneDecisions>).every(
    (k) => slotLanes[k] === regexLanes[k]
  );
  return { slotLanes, regexLanes, agree };
}
