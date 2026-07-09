import { and, ilike, isNull, or } from "drizzle-orm";
import { db } from "../../db";
import { documents } from "../../db/schema";

// Keyword retrieval for the RAG slice (Phase 4). Deliberately minimal: tokenize
// the query, match tokens against document content with ILIKE, return the top N
// rows. No embeddings, no pgvector, no full-text search yet — those are deferred.
//
// Returns [] when there are no usable keywords or nothing matches; the caller
// then answers ungrounded (guardrails still apply) rather than citing anything.

export type RetrievedDocument = {
  id: string;
  type: string;
  content: string;
  sourceUrl: string | null;
};

// Common words stripped so retrieval keys off meaningful terms.
const STOPWORDS = new Set([
  "the", "and", "for", "are", "you", "your", "how", "what", "should", "can",
  "with", "into", "from", "that", "this", "have", "has", "will", "would",
  "about", "want", "need", "get", "got", "who", "why", "when", "where", "which",
  "there", "their", "them", "they", "not", "but", "any", "all", "some",
]);

export async function searchDocuments(
  query: string,
  limit = 3
): Promise<RetrievedDocument[]> {
  const keywords = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    )
  );

  if (keywords.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      id: documents.id,
      type: documents.type,
      content: documents.content,
      sourceUrl: documents.sourceUrl,
    })
    .from(documents)
    .where(or(...keywords.map((w) => ilike(documents.content, `%${w}%`))))
    .limit(limit);

  return rows;
}

// Resource/course-link search tool for the agentic-chat POC (the second planner
// tool). Reuses the `documents` table but returns ONLY curated, linkable
// resources: rows that are GLOBAL (user_id IS NULL — curated knowledge, never a
// user's own uploaded document) and carry a real external URL (source_url starts
// with http). This keeps the `resources`/`courses` sections to verified DB links
// only — never invented — and, by restricting to global rows, also avoids leaking
// any user-owned document once resume upload lands. Returns [] when there are no
// usable keywords or nothing matches; the caller then says no verified resources
// were found.
export async function searchResources(
  query: string,
  limit = 5
): Promise<RetrievedDocument[]> {
  const keywords = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    )
  );

  if (keywords.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      id: documents.id,
      type: documents.type,
      content: documents.content,
      sourceUrl: documents.sourceUrl,
    })
    .from(documents)
    .where(
      and(
        isNull(documents.userId),
        ilike(documents.sourceUrl, "http%"),
        or(...keywords.map((w) => ilike(documents.content, `%${w}%`)))
      )
    )
    .limit(limit);

  return rows;
}
