// Factual-grounding policy — the deterministic half of grounding enforcement.
//
// WHY THIS EXISTS: the Verification Agent's hard checks are all SUBSET checks over
// structured sections (an agency/resource/course in the draft must trace to a Career
// Data row). Free-text QUANTITATIVE assertions — "18-24 LPA", "demand grew 34%",
// "the 3rd fastest-growing role", "hiring 40,000 freshers" — are a subset of nothing,
// so no hard check could ever fail them. The soft LLM check's `grounded` verdict was
// the only reader of that prose, and it was computed and then discarded.
//
// This module supplies the missing floor. It is deliberately CLAIM-LEVEL, not
// answer-level: gating a whole answer on one boolean is what makes a grounding check
// destroy useful advice. Here, a sentence with no quantitative assertion produces no
// claim at all, so pure guidance ("build two portfolio projects") is structurally
// invisible to the gate.
//
// It is also claim-TYPE agnostic on purpose. There is no salary branch, no "market
// demand" keyword list. Salary, growth percentages, hiring counts, rankings and
// timelines all reduce to the same primitive: a magnitude carrying a unit. One
// detector covers every one of them, and covers the next one nobody thought of.
//
// Pure, LLM-free and total — it must hold precisely when the soft check is
// unavailable, which is when fabrication is least likely to be caught otherwise.
import type { ResponseSections, SectionName } from "../schema";
import type { CareerDataAgentOutput, ProfileAgentOutput } from "./contracts";

// --- Numeric model -------------------------------------------------------------
// Every magnitude is an INTERVAL, never a scalar. "12 LPA" is [12L, 12L] and
// "18-24 LPA" is [18L, 24L], so a range in the draft and a range in the evidence
// compare by overlap rather than by string identity. Exact equality would reject
// "roughly 12.5 LPA" against evidence saying "12 LPA" — a rounding difference is not
// a fabrication, and treating it as one is the false-positive engine we are avoiding.
export type ClaimKind = "money" | "percent" | "duration" | "count" | "rank";

export type NumericValue = {
  kind: ClaimKind;
  // Normalized to the kind's canonical unit: money -> absolute currency units,
  // duration -> months, percent -> percentage points, count/rank -> as written.
  low: number;
  high: number;
  raw: string;
};

// Relative slack applied to BOTH sides before testing overlap. Absorbs rounding and
// unit-conversion drift (12 lakh vs 1,200,000 vs 12.0 LPA) while staying far too
// tight to launder an invention: because BOTH intervals widen, two point values
// overlap only when they are within ~2x TOLERANCE of each other, so 15 LPA does not
// ground a claim of 18 LPA. Loosening this is the one change here most likely to
// turn the gate permissive — 10% already bridged that pair.
const TOLERANCE = 0.05;

const NUM = String.raw`\d{1,3}(?:,\d{2,3})*(?:\.\d+)?|\d+(?:\.\d+)?`;
// A range is "N", "N-M", "N–M" or "N to M". The second endpoint is optional so a
// single magnitude flows through the same parser as a range and becomes [n, n].
const RANGE = String.raw`(${NUM})(?:\s*(?:-|–|—|to)\s*(${NUM}))?`;
const CURRENCY = String.raw`₹|rs\.?|inr|\$|usd|€|eur`;
// Duration and percent are matched BEFORE money so the single-letter money scales
// ("k", "m") cannot swallow the leading letter of "months".
const DURATION_UNIT = String.raw`years?|yrs?|months?|mos?|weeks?|wks?|days?`;
const PERCENT_UNIT = String.raw`%|percent|per cent|percentage points?|pp`;
const MONEY_UNIT = String.raw`lpa|lakhs?|lacs?|crores?|million|billion|bn|k|m`;

// The unit is closed with (?!\w) rather than \b: "%" is not a word character, so a
// trailing \b never matches "22%" at the end of a sentence — which silently demoted
// every percentage to a bare count and dropped it. (?!\w) closes word units and
// symbol units alike.
const MENTION = new RegExp(
  String.raw`(?:(${CURRENCY})\s*)?${RANGE}\s*(?:(${DURATION_UNIT}|${PERCENT_UNIT}|${MONEY_UNIT})(?!\w))?`,
  "gi"
);
const ORDINAL = /\b(\d+)(?:st|nd|rd|th)\b/gi;

// Canonical unit + multiplier for a written unit token.
function unitScale(unit: string | undefined, hasCurrency: boolean): { kind: ClaimKind; factor: number } | null {
  const u = (unit ?? "").toLowerCase().replace(/\.$/, "");
  switch (true) {
    case /^years?$|^yrs?$/.test(u):
      return { kind: "duration", factor: 12 };
    case /^months?$|^mos?$/.test(u):
      return { kind: "duration", factor: 1 };
    case /^weeks?$|^wks?$/.test(u):
      return { kind: "duration", factor: 0.25 };
    case /^days?$/.test(u):
      return { kind: "duration", factor: 1 / 30 };
    case /^%$|^percent$|^per cent$|^percentage points?$|^pp$/.test(u):
      return { kind: "percent", factor: 1 };
    case /^lpa$|^lakhs?$|^lacs?$/.test(u):
      return { kind: "money", factor: 1e5 };
    case /^crores?$/.test(u):
      return { kind: "money", factor: 1e7 };
    case /^k$/.test(u):
      return { kind: "money", factor: 1e3 };
    case /^m$|^million$/.test(u):
      return { kind: "money", factor: 1e6 };
    case /^billion$|^bn$/.test(u):
      return { kind: "money", factor: 1e9 };
    case u === "":
      // A bare magnitude. With a currency symbol it is money; otherwise it is only a
      // factual claim if its size makes it a statistic (see toValue).
      return hasCurrency ? { kind: "money", factor: 1 } : { kind: "count", factor: 1 };
    default:
      return null;
  }
}

function toNumber(text: string): number {
  return Number(text.replace(/,/g, ""));
}

// Bare counts are where false positives would come from: "3 projects", "2 rounds",
// "step 4" are advice, not statistics. Only a magnitude large enough to BE a
// statistic (>= 1000, e.g. "40,000 freshers") is treated as a factual claim, and a
// bare four-digit year is never one.
function isEnforceableBareCount(low: number, raw: string): boolean {
  const isYearLike = Number.isInteger(low) && low >= 1900 && low <= 2100 && !raw.includes(",");
  return !isYearLike && low >= 1000;
}

// Every numeric magnitude in a piece of text, as normalized intervals.
// Exported for tests — the parser is the part most worth pinning down.
export function extractValues(text: string): NumericValue[] {
  const out: NumericValue[] = [];

  for (const m of text.matchAll(MENTION)) {
    const [raw, currency, first, second, unit] = m;
    if (!first) continue;
    const scale = unitScale(unit, !!currency);
    if (!scale) continue;

    const a = toNumber(first) * scale.factor;
    const b = second === undefined ? a : toNumber(second) * scale.factor;
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
    if (scale.kind === "count" && !isEnforceableBareCount(low, first)) continue;

    out.push({ kind: scale.kind, low, high, raw: raw.trim() });
  }

  for (const m of text.matchAll(ORDINAL)) {
    const n = toNumber(m[1]);
    if (Number.isFinite(n)) out.push({ kind: "rank", low: n, high: n, raw: m[0] });
  }

  return out;
}

// Range-aware support: the claim's interval must OVERLAP an evidence interval of the
// same kind, each widened by TOLERANCE. Containment and partial overlap both count —
// an answer narrowing evidence's "10-30%" to "15-20%" is reading the source, not
// inventing. Kinds never cross, so a 12% growth figure can never be "supported" by a
// 12-month timeline that happens to share a digit.
function supports(claim: NumericValue, evidence: NumericValue): boolean {
  if (claim.kind !== evidence.kind) return false;
  const pad = (v: NumericValue) => ({
    low: v.low - Math.abs(v.low) * TOLERANCE,
    high: v.high + Math.abs(v.high) * TOLERANCE,
  });
  const a = pad(claim);
  const b = pad(evidence);
  return a.low <= b.high && b.low <= a.high;
}

// --- Hedging -------------------------------------------------------------------
// The escape hatch that keeps this policy from suppressing useful guidance. A figure
// the model explicitly frames as an estimate is permitted even with no evidence,
// which is exactly the "marked as estimate/unsupported" branch the policy requires.
// Centralized in ONE table rather than scattered through the checks, so the policy
// is auditable in a single place instead of being a pile of string comparisons.
const HEDGE_MARKERS = [
  "approximately", "approx", "around", "roughly", "about", "typically", "generally",
  "usually", "varies", "vary", "varying", "estimate", "estimated", "rough", "ballpark",
  "indicative", "illustrative", "rule of thumb", "order of magnitude", "depends",
  "depend on", "not verified", "unverified", "no verified", "cannot confirm",
  "can't confirm", "do not have verified", "don't have verified", "hypothetical",
  "for reference only", "as a general guide", "may range", "can range", "could range",
  "subject to change", "i don't have", "i do not have",
];

export function isHedged(sentence: string): boolean {
  const s = sentence.toLowerCase();
  return HEDGE_MARKERS.some((h) => s.includes(h));
}

// --- Claim extraction ----------------------------------------------------------
export type ClaimVerdict = "grounded" | "hedged" | "unsupported";

export type FactualClaim = {
  section: SectionName;
  sentence: string;
  values: NumericValue[];
  verdict: ClaimVerdict;
};

// List scaffolding is structure, not assertion: "3." / "Step 2:" / "Month 1-3 —"
// number the plan rather than claim anything about the world. Stripped before
// extraction so an ordered roadmap never reads as four unsupported statistics.
function stripStructure(item: string): string {
  return item
    .replace(/^\s*(?:step|phase|stage)?\s*\d+\s*[.):\-–]\s*/i, "")
    .replace(/^\s*(?:month|week|day|quarter)s?\s*\d+(?:\s*[-–]\s*\d+)?\s*[:.\-–]\s*/i, "");
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// The free-text units to inspect, paired with their section so an issue can name
// where the claim came from. A roadmap already flagged `suggested:true` is presented
// to the user as general guidance rather than data, so its TIMELINES are self-
// labelled estimates — but money, percentages and rankings inside it are still
// factual assertions and stay enforced.
function claimUnits(sections: ResponseSections): { section: SectionName; text: string; kinds?: ClaimKind[] }[] {
  const units: { section: SectionName; text: string; kinds?: ClaimKind[] }[] = [];
  if (sections.ai_suggestion?.trim()) units.push({ section: "ai_suggestion", text: sections.ai_suggestion });
  const roadmapKinds: ClaimKind[] | undefined = sections.roadmap?.suggested
    ? ["money", "percent", "rank"]
    : undefined;
  for (const item of sections.roadmap?.items ?? []) {
    units.push({ section: "roadmap", text: stripStructure(item), kinds: roadmapKinds });
  }
  for (const item of sections.skill_focus ?? []) units.push({ section: "skill_focus", text: stripStructure(item) });
  for (const item of sections.next_steps ?? []) units.push({ section: "next_steps", text: stripStructure(item) });
  return units;
}

// --- Evidence ------------------------------------------------------------------
// Everything a figure may legitimately come from. The user's own profile, memory and
// question are evidence about the user: restating "you have 3 years of experience" or
// "your 12 LPA target" must never be flagged, and this is what guarantees it.
export type GroundingEvidence = {
  careerData: CareerDataAgentOutput;
  query: string;
  profile?: ProfileAgentOutput;
};

export function collectEvidenceText(evidence: GroundingEvidence): string[] {
  const { careerData, query, profile } = evidence;
  const parts: string[] = [query];

  for (const d of careerData.ragDocs) parts.push(d.content);
  for (const row of [
    ...(careerData.roadmaps ?? []),
    ...(careerData.marketSignals ?? []),
    ...(careerData.industryArticles ?? []),
  ]) {
    parts.push(row.title, row.snippet);
  }
  for (const r of [...careerData.resources, ...careerData.courses]) parts.push(r.title);
  for (const a of careerData.agencies) parts.push(a.name, a.services ?? "", a.location ?? "");
  for (const note of careerData.missingDataNotes) parts.push(note);

  if (profile) {
    parts.push(profile.profileSummary, profile.memorySummary, ...profile.importantConstraints);
    const c = profile.userContext;
    parts.push(c.stage ?? "", c.currentRole ?? "", c.careerGoal ?? "", c.location ?? "", ...c.skills, ...c.interests);
  }

  return parts.filter((p) => p && p.trim().length > 0);
}

// --- Policy entrypoint ---------------------------------------------------------
export type GroundingReport = {
  claims: FactualClaim[];
  unsupported: FactualClaim[];
};

// Prefix every unsupported-claim issue carries, so the regeneration brief and the
// tests key on a constant instead of on prose.
export const UNSUPPORTED_CLAIM_ISSUE = "Unsupported factual claim(s)";

export function checkFactualGrounding(
  sections: ResponseSections,
  evidence: GroundingEvidence
): GroundingReport {
  const evidenceValues = collectEvidenceText(evidence).flatMap(extractValues);
  const claims: FactualClaim[] = [];

  for (const unit of claimUnits(sections)) {
    for (const sentence of sentencesOf(unit.text)) {
      const values = extractValues(sentence).filter((v) => !unit.kinds || unit.kinds.includes(v.kind));
      if (values.length === 0) continue; // No quantitative assertion — not a claim.

      const unsupportedValues = values.filter((v) => !evidenceValues.some((e) => supports(v, e)));
      const verdict: ClaimVerdict =
        unsupportedValues.length === 0 ? "grounded" : isHedged(sentence) ? "hedged" : "unsupported";
      claims.push({ section: unit.section, sentence, values: unsupportedValues, verdict });
    }
  }

  return { claims, unsupported: claims.filter((c) => c.verdict === "unsupported") };
}

// One issue line naming the exact offending figures, so the regeneration brief tells
// the model what to remove or hedge instead of asking it to guess.
export function describeUnsupported(unsupported: FactualClaim[]): string {
  const figures = [...new Set(unsupported.flatMap((c) => c.values.map((v) => v.raw)))];
  const sections = [...new Set(unsupported.map((c) => c.section))];
  return `${UNSUPPORTED_CLAIM_ISSUE} in ${sections.join(", ")} not supported by any retrieved evidence: ${figures.join("; ")}.`;
}
