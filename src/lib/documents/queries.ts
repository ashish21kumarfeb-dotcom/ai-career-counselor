import { and, eq, ilike, isNull, or } from "drizzle-orm";
import { db } from "../../db";
import { documents } from "../../db/schema";

// Keyword retrieval for the RAG / resource slices. Deliberately minimal (no
// embeddings, no pgvector, no full-text search yet — those are deferred), but
// RELEVANCE-AWARE: a document is only relevant if it matches a SPECIFIC (topic)
// term from the query, not merely a generic learning word.
//
// Why this matters: a naive OR-ILIKE over every query token pulls in unrelated
// documents. For "I want to learn Azure", the tokens are "learn" + "azure";
// "learn" alone matches almost every learning doc (roadmaps, "learners",
// "MDN Learn…"), drowning out (or faking) relevance. So we split tokens into
// generic learning words vs. specific topic words, require a specific-word match
// for inclusion, and rank by a relevance score. If the query carries no specific
// topic term, we return [] rather than guess — no unrelated links.

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

// Low-signal learning-intent words. They appear in almost every career/learning
// document, so a match on one of these ALONE does not make a document relevant —
// it must also match a specific topic term. These mirror the resource-gate
// vocabulary but are used here to DEMOTE, not to gate.
const GENERIC_TERMS = new Set([
  "learn", "learning", "roadmap", "roadmaps", "course", "courses", "certification",
  "certificate", "certificates", "certified", "skill", "skills", "career", "careers",
  "path", "paths", "become", "becoming", "switch", "switching", "transition",
  "transitioning", "prepare", "preparation", "preparing", "resource", "resources",
  "study", "studies", "studying", "tutorial", "tutorials", "material", "materials",
  "upskill", "training", "guide", "guides", "guidance", "professional", "beginner",
  "entry", "level", "online", "free", "best", "top", "start", "starting", "begin",
  "job", "jobs", "role", "roles", "work", "field", "advice", "suggest", "recommend",
]);

// Tokenize into distinct, meaningful lowercase keywords.
function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    )
  );
}

// Relevance score for a document against the query keywords. Specific (topic)
// matches weigh heavily; generic learning-word matches add a little; extra
// context terms (profile skills / career goal) nudge ranking but never grant
// inclusion on their own.
function scoreDocument(
  content: string,
  sourceUrl: string | null,
  keywords: string[],
  specific: Set<string>,
  contextTerms: string[]
): number {
  const hay = `${content} ${sourceUrl ?? ""}`.toLowerCase();
  let score = 0;
  for (const k of keywords) {
    if (hay.includes(k)) score += specific.has(k) ? 3 : 1;
  }
  for (const c of contextTerms) {
    if (!keywords.includes(c) && hay.includes(c)) score += 1;
  }
  return score;
}

// Shared relevance-ranked retrieval. `globalHttpOnly` restricts to curated,
// linkable rows (global + real http URL) for the resource/course tools.
async function retrieve(
  query: string,
  limit: number,
  contextTerms: string[],
  globalHttpOnly: boolean,
  ownerId?: string
): Promise<RetrievedDocument[]> {
  const keywords = tokenize(query);
  if (keywords.length === 0) return [];

  // A document must match a SPECIFIC topic term. If the query has none (only
  // generic learning words), there is no topic to be relevant to -> return [].
  const specificArr = keywords.filter((w) => !GENERIC_TERMS.has(w));
  if (specificArr.length === 0) return [];
  const specific = new Set(specificArr);

  const topicMatch = or(...specificArr.map((w) => ilike(documents.content, `%${w}%`)));
  // User scoping for RAG grounding: a query may retrieve GLOBAL curated docs plus
  // the requesting user's OWN documents (e.g. their uploaded resume), but never
  // another user's documents. With no ownerId, only global docs are visible.
  const userScope = ownerId
    ? or(isNull(documents.userId), eq(documents.userId, ownerId))
    : isNull(documents.userId);
  const where = globalHttpOnly
    ? and(isNull(documents.userId), ilike(documents.sourceUrl, "http%"), topicMatch)
    : and(userScope, topicMatch);

  // Fetch a candidate pool, then rank in code and take the top `limit`.
  const candidates = await db
    .select({
      id: documents.id,
      type: documents.type,
      content: documents.content,
      sourceUrl: documents.sourceUrl,
    })
    .from(documents)
    .where(where)
    .limit(Math.max(limit * 6, 24));

  const scored = candidates
    .map((r) => ({ r, score: scoreDocument(r.content, r.sourceUrl, keywords, specific, contextTerms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return [];

  // Relative relevance cutoff: keep only documents scoring within 60% of the best
  // match. This drops incidental single-term substring hits (e.g. a query for
  // "data analyst" grazing "database" in an Azure doc, or "web development"
  // grazing "web apps") while keeping genuinely on-topic results — which match
  // more of the query's specific terms and therefore score higher.
  const cutoff = scored[0].score * 0.6;
  return scored
    .filter((x) => x.score >= cutoff)
    .slice(0, limit)
    .map((x) => x.r);
}

// RAG grounding retrieval. Relevance-ranked and USER-SCOPED: returns global
// curated docs plus the requesting user's own documents (e.g. their resume),
// never another user's. Pass the current user's id; omit it to retrieve only
// global docs. Returns [] when no specific topic term matches, so the caller
// answers ungrounded rather than citing something irrelevant.
export async function searchDocuments(
  query: string,
  userId?: string,
  limit = 3,
  contextTerms: string[] = []
): Promise<RetrievedDocument[]> {
  return retrieve(query, limit, contextTerms, false, userId);
}

// Resource/course-link search tool. Returns ONLY curated, linkable resources:
// GLOBAL rows (user_id IS NULL — never a user's own uploaded document) carrying a
// real external URL (source_url starts with http). This keeps the resources/
// courses sections to verified DB links only — never invented — and, being
// relevance-ranked, only returns links actually on-topic for the query. Returns
// [] when nothing on-topic matches; the caller then says no verified resources
// were found rather than showing unrelated links.
export async function searchResources(
  query: string,
  limit = 5,
  contextTerms: string[] = []
): Promise<RetrievedDocument[]> {
  return retrieve(query, limit, contextTerms, true);
}
