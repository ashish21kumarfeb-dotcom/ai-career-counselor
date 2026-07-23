// Export production ai_recommendations rows as an offline-evaluation dataset
// (JSONL) for the Python RAGAS harness in eval/.
//
//   npm run eval:export -- [--limit 200] [--since 2026-01-01] [--out path]
//
// Context reconstruction, per row (see src/lib/eval/export.ts):
//   1. sources_used excerpts (rows written after the enrichment) — direct.
//   2. Legacy refs without excerpts — joined back to documents /
//      consulting_agencies by id where those rows still exist.
//   3. External snippets — recovered from the conversation_messages.response
//      render snapshot (joined via recommendation_id).
// Rows whose contexts stay partial are tagged contexts_complete:false so the
// harness can filter faithfulness honestly rather than punishing the answer for
// the export's gap.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { desc, gte, inArray, eq } from "drizzle-orm";
import { db } from "../src/db";
import { aiRecommendations, documents, consultingAgencies, conversationMessages } from "../src/db/schema";
import { flattenAnswer, contextsFromSources, toJsonl, type EvalCase, type PersistedSourceRef } from "../src/lib/eval/export";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const limit = Math.min(Number.parseInt(arg("limit") ?? "200", 10) || 200, 1000);
const since = arg("since");
const date = new Date().toISOString().slice(0, 10);
const out = arg("out") ?? join("eval", "datasets", `prod-${date}.jsonl`);

const rows = await db
  .select()
  .from(aiRecommendations)
  .where(since ? gte(aiRecommendations.createdAt, new Date(since)) : undefined)
  .orderBy(desc(aiRecommendations.createdAt))
  .limit(limit);

console.log(`[eval-export] ${rows.length} recommendation row(s) selected.`);

// Bulk-resolve legacy refs: collect every excerpt-less id per source table, one
// query each, then hand contextsFromSources a lookup map.
const docIds = new Set<string>();
const agencyIds = new Set<string>();
for (const row of rows) {
  const refs = (row.sourcesUsed as PersistedSourceRef[] | null) ?? [];
  for (const ref of refs) {
    if (typeof ref.excerpt === "string" && ref.excerpt.trim()) continue;
    if (typeof ref.id !== "string" || typeof ref.type !== "string") continue;
    if (ref.type === "agency") agencyIds.add(ref.id);
    else if (!ref.type.startsWith("external_")) docIds.add(ref.id);
  }
}
const docText = new Map<string, string>();
if (docIds.size > 0) {
  const docRows = await db
    .select({ id: documents.id, content: documents.content })
    .from(documents)
    .where(inArray(documents.id, [...docIds]));
  for (const d of docRows) docText.set(d.id, d.content);
}
const agencyText = new Map<string, string>();
if (agencyIds.size > 0) {
  const agencyRows = await db
    .select({ id: consultingAgencies.id, name: consultingAgencies.name, location: consultingAgencies.location, services: consultingAgencies.services })
    .from(consultingAgencies)
    .where(inArray(consultingAgencies.id, [...agencyIds]));
  for (const a of agencyRows) {
    agencyText.set(a.id, [a.name, a.location, a.services].filter(Boolean).join(" — "));
  }
}

// External snippets live only in the render snapshot; fetch per row (bounded by
// --limit, and only rows that still need them).
async function externalSnippets(recommendationId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const turns = await db
    .select({ response: conversationMessages.response })
    .from(conversationMessages)
    .where(eq(conversationMessages.recommendationId, recommendationId))
    .limit(1);
  const external = (turns[0]?.response as { external?: Record<string, Array<{ url?: string; snippet?: string }>> } | null)?.external;
  for (const lane of Object.values(external ?? {})) {
    for (const r of lane ?? []) {
      if (r?.url && r?.snippet) map.set(r.url, r.snippet);
    }
  }
  return map;
}

const cases: EvalCase[] = [];
for (const row of rows) {
  const refs = (row.sourcesUsed as PersistedSourceRef[] | null) ?? [];
  const needsSnapshot = refs.some(
    (r) => typeof r.type === "string" && r.type.startsWith("external_") && !(typeof r.excerpt === "string" && r.excerpt.trim())
  );
  const snippets = needsSnapshot ? await externalSnippets(row.id) : new Map<string, string>();

  const { contexts, complete } = contextsFromSources(refs, ({ id, type }) => {
    if (type === "agency") return agencyText.get(id);
    if (type.startsWith("external_")) return snippets.get(id);
    return docText.get(id);
  });

  cases.push({
    case_id: row.id,
    query: row.query,
    answer: flattenAnswer(row.finalAnswer),
    contexts,
    intent: row.intent ?? undefined,
    contexts_complete: complete,
    runtime_eval: row.evaluationScore ?? undefined,
    created_at: row.createdAt.toISOString(),
  });
}

const usable = cases.filter((c) => c.answer.trim().length > 0);
const complete = usable.filter((c) => c.contexts_complete).length;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, toJsonl(usable), "utf8");
console.log(`[eval-export] wrote ${usable.length} case(s) (${complete} with complete contexts) -> ${out}`);
process.exit(0);
