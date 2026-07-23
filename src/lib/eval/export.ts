// Pure helpers for the offline-evaluation dataset export. No I/O here — the DB
// reads live in scripts/eval-export.mts and the graph runs in
// scripts/eval-run-golden.mts; these functions turn persisted rows into the
// JSONL case shape the Python harness (eval/run_ragas.py) consumes, and are
// unit-tested in tests/eval-export.test.mts.
import type { ResponseSections } from "../agent/schema";

// One evaluation case, mirroring the RAGAS sample shape:
//   question / answer / contexts (+ optional reference for context_recall).
export type EvalCase = {
  case_id: string;
  query: string;
  answer: string;
  contexts: string[];
  intent?: string;
  ground_truth?: string;
  // Honest flag: false when the grounding contexts could not be fully
  // reconstructed (legacy rows without excerpts). Faithfulness over incomplete
  // contexts penalizes the ANSWER for the EXPORT's gap, so the harness filters
  // on this rather than pretending.
  contexts_complete: boolean;
  runtime_eval?: unknown;
  created_at?: string;
};

// Flatten the sectioned answer JSON persisted in ai_recommendations.final_answer
// into prose. Mirrors summarizeAssistantTurn (conversations/summarize.ts) but
// UNCAPPED — that one is sized for a chat-history window; an evaluation must
// judge the whole answer, not its first 1500 chars.
export function flattenAnswer(finalAnswer: string | null | undefined): string {
  if (!finalAnswer) return "";
  let s: ResponseSections;
  try {
    s = JSON.parse(finalAnswer) as ResponseSections;
  } catch {
    // Pre-sectioned legacy rows stored plain text; use it as-is.
    return finalAnswer;
  }
  const parts: string[] = [];
  if (s.ai_suggestion?.trim()) parts.push(s.ai_suggestion.trim());
  if (s.roadmap?.items?.length) parts.push(`Roadmap: ${s.roadmap.items.join("; ")}`);
  if (s.skill_focus?.length) parts.push(`Skills to focus on: ${s.skill_focus.join(", ")}`);
  if (s.next_steps?.length) parts.push(`Next steps: ${s.next_steps.join("; ")}`);
  const learning = [
    ...(s.resources?.items?.map((r) => r.title).filter(Boolean) ?? []),
    ...(s.courses?.items?.map((c) => c.title).filter(Boolean) ?? []),
  ];
  if (learning.length) parts.push(`Resources/courses: ${learning.join(", ")}`);
  const agencyNames = s.agencies?.items?.map((a) => a.name).filter(Boolean) ?? [];
  if (agencyNames.length) parts.push(`Agencies: ${agencyNames.join(", ")}`);
  return parts.join("\n");
}

// The persisted sources_used ref shape (contracts.ts sourceRefSchema). Untyped
// jsonb at read time, so fields are defensive.
export type PersistedSourceRef = {
  id?: unknown;
  type?: unknown;
  sourceUrl?: unknown;
  excerpt?: unknown;
};

// Reconstruct grounding contexts from persisted source refs. Excerpt-bearing
// refs (rows written after the enrichment) become contexts directly; refs
// without one can be resolved by the caller-supplied lookup (a DB join in the
// export script, absent in tests). complete=false whenever any ref stayed
// text-less or the row had no refs at all.
export function contextsFromSources(
  sources: PersistedSourceRef[] | null | undefined,
  resolve?: (ref: { id: string; type: string }) => string | undefined
): { contexts: string[]; complete: boolean } {
  const refs = Array.isArray(sources) ? sources : [];
  if (refs.length === 0) return { contexts: [], complete: false };

  const contexts: string[] = [];
  let unresolved = 0;
  for (const ref of refs) {
    const excerpt = typeof ref.excerpt === "string" && ref.excerpt.trim() ? ref.excerpt.trim() : undefined;
    if (excerpt) {
      contexts.push(excerpt);
      continue;
    }
    const id = typeof ref.id === "string" ? ref.id : "";
    const type = typeof ref.type === "string" ? ref.type : "";
    const resolved = id && resolve ? resolve({ id, type }) : undefined;
    if (resolved?.trim()) contexts.push(resolved.trim().slice(0, 400));
    else unresolved++;
  }
  return { contexts, complete: unresolved === 0 && contexts.length > 0 };
}

// Serialize cases as JSONL (one JSON object per line — the exchange format both
// the TS exporters and the Python harness agree on).
export function toJsonl(cases: EvalCase[]): string {
  return cases.map((c) => JSON.stringify(c)).join("\n") + (cases.length ? "\n" : "");
}
