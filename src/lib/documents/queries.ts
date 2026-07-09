import { ilike, or } from "drizzle-orm";
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
