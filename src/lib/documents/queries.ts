import { and, eq, ilike, isNull, or } from "drizzle-orm";
import { db } from "../../db";
import { documents, documentChunks } from "../../db/schema";
import { TARGET_CHUNK_CHARS } from "./chunk";

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
// The second block (from "market" on) is MARKET-QUESTION FRAMING: the words a user
// wraps around a subject when asking about the state of a field — "what is the
// current market scope for X", "average salary for Y", "is there demand for Z".
// They are not topics, and treating them as topics is how a question about one
// field retrieved documents about another: the framing matched, the subject did not.
// The external-search layer already strips exactly this vocabulary (FOCUS_STOPWORDS
// in src/lib/external/tavily.ts) to isolate the subject; DB retrieval did not, so the
// two layers disagreed about what the query was even ABOUT. Listed here they are
// DEMOTED, not banned: a document may still match them for ranking, it just cannot
// earn inclusion on them alone.
const GENERIC_TERMS = new Set([
  "learn", "learning", "roadmap", "roadmaps", "course", "courses", "certification",
  "certificate", "certificates", "certified", "skill", "skills", "career", "careers",
  "path", "paths", "become", "becoming", "switch", "switching", "transition",
  "transitioning", "prepare", "preparation", "preparing", "resource", "resources",
  "study", "studies", "studying", "tutorial", "tutorials", "material", "materials",
  "upskill", "training", "guide", "guides", "guidance", "professional", "beginner",
  "entry", "level", "online", "free", "best", "top", "start", "starting", "begin",
  "job", "jobs", "role", "roles", "work", "field", "advice", "suggest", "recommend",
  "market", "markets", "scope", "demand", "trend", "trends", "outlook", "growth",
  "future", "current", "currently", "latest", "recent", "opportunity",
  "opportunities", "salary", "salaries", "pay", "compensation", "wage", "wages",
  "average", "median", "typical", "industry", "industries", "hiring", "employment",
  "openings", "vacancy", "vacancies", "statistics", "overview", "state", "analysis",
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
): { score: number; specificHits: number } {
  const hay = `${content} ${sourceUrl ?? ""}`.toLowerCase();
  let score = 0;
  let specificHits = 0;
  for (const k of keywords) {
    if (!hay.includes(k)) continue;
    if (specific.has(k)) {
      score += 3;
      specificHits++;
    } else {
      score += 1;
    }
  }
  for (const c of contextTerms) {
    if (!keywords.includes(c) && hay.includes(c)) score += 1;
  }
  return { score, specificHits };
}

// How many of the query's specific terms a document must actually contain.
//
// THE BUG THIS FIXES: relevance used to be judged only RELATIVELY — keep everything
// scoring within 60% of the best match. That silently assumes the best match is
// itself relevant. When the corpus contains NOTHING about the subject, the best
// match is a false positive and the relative cutoff faithfully preserves it, plus
// every other document just as wrong. Asked about cyber security, a corpus with no
// cyber-security document returned two Azure pages, because each happened to list
// the word "security" among Azure's features. One incidental word out of a two-word
// subject was scored as a full match, and nothing downstream could tell the
// difference between "the best we have" and "good enough to show".
//
// So: an ABSOLUTE floor. A document must match at least TWO distinct specific terms
// — enough that a single incidental word cannot carry it — or ALL of them when the
// query names fewer than two. Deliberately a small constant rather than a fraction
// of the query length: a long query ("backend developer roles in Bangalore using
// Python and SQL") should not demand ever more coverage, because its extra terms are
// refinements, and a document matching two of them is genuinely on topic. Entirely
// domain-agnostic — it counts term overlap and knows nothing about any field.
function requiredSpecificHits(specificCount: number): number {
  return Math.min(2, specificCount);
}

// Length normalization for chunk scores.
//
// THE BIAS IT CORRECTS: score counts DISTINCT matched terms, so it does not grow
// with repetition — but it does grow with breadth, and a longer passage has more
// chances to contain more distinct terms for no better reason than its size. Left
// uncorrected, chunking makes this worse rather than better: a document split
// into one 1200-char chunk and one 250-char chunk would systematically surface
// the long one even when the short one is squarely on topic.
//
// Sub-linear (log) rather than dividing by raw length. Dividing by length
// over-corrects hard in the other direction — it makes a 30-character fragment
// containing one term outrank a well-argued paragraph containing three — and the
// fragment is the worse passage to ground an answer on even though it is "denser".
// The log damps the size advantage without inverting it.
function normalizeByLength(score: number, chunkChars: number): number {
  return score / (1 + Math.log(1 + chunkChars / TARGET_CHUNK_CHARS));
}

// Shared relevance-ranked retrieval, matched at CHUNK granularity.
//
// `globalHttpOnly` restricts to curated, linkable rows (global + real http URL)
// for the resource/course tools.
//
// `returnPassage` decides what the caller gets back, and the two lanes genuinely
// want different things:
//   - RAG grounding wants the MATCHED PASSAGE. That is the whole point of
//     chunking: inject the paragraph that answers the question, not the eight
//     that surround it.
//   - The resource/course lane wants the DOCUMENT's text, because its output is a
//     link whose title is derived from the leading text (titleOf() reads up to
//     the first colon). Handing it a passage from the middle of a document would
//     render a link labelled with a mid-sentence fragment.
// Both lanes still MATCH on chunks — recall improves either way.
async function retrieve(
  query: string,
  limit: number,
  contextTerms: string[],
  globalHttpOnly: boolean,
  ownerId: string | undefined,
  returnPassage: boolean
): Promise<RetrievedDocument[]> {
  const keywords = tokenize(query);
  if (keywords.length === 0) return [];

  // A document must match a SPECIFIC topic term. If the query has none (only
  // generic learning words), there is no topic to be relevant to -> return [].
  const specificArr = keywords.filter((w) => !GENERIC_TERMS.has(w));
  if (specificArr.length === 0) return [];
  const specific = new Set(specificArr);

  // Topic matching moves to the chunk. Ownership and linkability stay on the
  // document — they are properties of the source, not of a passage — which is why
  // this is a join rather than a lookup: the row that decides VISIBILITY and the
  // row that decides RELEVANCE are no longer the same row.
  const topicMatch = or(...specificArr.map((w) => ilike(documentChunks.content, `%${w}%`)));
  // User scoping for RAG grounding: a query may retrieve GLOBAL curated docs plus
  // the requesting user's OWN documents (e.g. their uploaded resume), but never
  // another user's documents. With no ownerId, only global docs are visible.
  const userScope = ownerId
    ? or(isNull(documents.userId), eq(documents.userId, ownerId))
    : isNull(documents.userId);
  const where = globalHttpOnly
    ? and(isNull(documents.userId), ilike(documents.sourceUrl, "http%"), topicMatch)
    : and(userScope, topicMatch);

  // Candidate pool is larger than it was at document granularity: one document
  // can now contribute many rows, so the same pool size would survey fewer
  // distinct documents than before.
  const candidates = await db
    .select({
      id: documents.id,
      type: documents.type,
      documentContent: documents.content,
      chunkContent: documentChunks.content,
      sourceUrl: documents.sourceUrl,
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    .where(where)
    .limit(Math.max(limit * 12, 48));

  // Absolute floor FIRST (is this passage about the subject at all?), then the
  // relative cutoff below (is it among the better answers?). Order matters: the
  // relative step is measured against the surviving best, so a corpus that has
  // nothing on topic now yields an empty result rather than a confidently ranked
  // list of near-misses.
  //
  // The floor is applied to the RAW hit count, deliberately not to the normalized
  // score. The floor asks a yes/no question about topicality — "does this passage
  // contain at least two of the query's specific terms?" — and length has no
  // bearing on that. Normalizing it would let a short chunk fail the floor purely
  // for being short, which is the opposite of what the floor is for.
  const minHits = requiredSpecificHits(specificArr.length);
  const scored = candidates
    .map((r) => {
      const { score, specificHits } = scoreDocument(
        r.chunkContent,
        r.sourceUrl,
        keywords,
        specific,
        contextTerms
      );
      return { r, specificHits, score: normalizeByLength(score, r.chunkContent.length) };
    })
    .filter((x) => x.specificHits >= minHits)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return [];

  // PER-DOCUMENT DEDUP: keep only each document's best-scoring passage.
  //
  // Without this, `limit` counts passages rather than sources, and one long
  // repetitive document can fill every slot — the caller asked for three pieces of
  // evidence and receives three paragraphs of the same article, which reads to the
  // model (and to verification) as three independent corroborations. Taking the
  // best chunk per document keeps `limit` meaning what every caller already
  // assumes it means: distinct sources. The array is already sorted, so the first
  // occurrence of each document id is its best passage.
  const bestPerDocument = new Map<string, (typeof scored)[number]>();
  for (const entry of scored) {
    if (!bestPerDocument.has(entry.r.id)) bestPerDocument.set(entry.r.id, entry);
  }
  const deduped = [...bestPerDocument.values()];

  // Relative relevance cutoff: keep only documents scoring within 60% of the best
  // match. This drops incidental single-term substring hits (e.g. a query for
  // "data analyst" grazing "database" in an Azure doc, or "web development"
  // grazing "web apps") while keeping genuinely on-topic results — which match
  // more of the query's specific terms and therefore score higher.
  const cutoff = deduped[0].score * 0.6;
  return deduped
    .filter((x) => x.score >= cutoff)
    .slice(0, limit)
    .map((x) => ({
      // The DOCUMENT's id, not the chunk's. Everything downstream — sources_used,
      // the trace, dedup by caller — identifies evidence by document, and handing
      // back a chunk id would silently break that correspondence.
      id: x.r.id,
      type: x.r.type,
      content: returnPassage ? x.r.chunkContent : x.r.documentContent,
      sourceUrl: x.r.sourceUrl,
    }));
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
  return retrieve(query, limit, contextTerms, false, userId, true);
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
  // returnPassage: false — this lane renders links, and its title is derived from
  // the document's leading text. See the note on `retrieve`.
  return retrieve(query, limit, contextTerms, true, undefined, false);
}
