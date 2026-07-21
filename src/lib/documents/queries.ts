import { and, eq, ilike, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db";
import { documents, documentChunks } from "../../db/schema";
import { embedQuery } from "../ai/embeddings";
import { TARGET_CHUNK_CHARS } from "./chunk";

// HYBRID retrieval for the RAG / resource slices: a lexical lane (Postgres
// full-text search) and a semantic lane (pgvector nearest neighbours over Voyage
// embeddings), fused by Reciprocal Rank Fusion.
//
// The two lanes exist because they fail differently, and each one's failures are
// the other's strength. Lexical search cannot match "ML engineer" to "machine
// learning" or "fresher" to "entry-level"; vector search cannot be trusted to
// abstain, because a nearest-neighbour query always returns its closest guess even
// when the corpus knows nothing about the subject. Running both and fusing ranks
// keeps the recall of one and the discipline of the other.
//
// If embeddings are unconfigured or the provider fails, the semantic lane returns
// nothing and this degrades to pure lexical retrieval — worse recall on paraphrased
// questions, and nothing else. That is a deliberate property, not an accident: an
// embeddings outage must never turn a search into an error.
//
// Both lanes are RELEVANCE-AWARE rather than merely matching. On the lexical side, a
// document is only relevant if it matches a SPECIFIC (topic) term from the query,
// not merely a generic learning word.
//
// Why that matters: a naive match over every query token pulls in unrelated
// documents. For "I want to learn Azure", the tokens are "learn" + "azure";
// "learn" alone matches almost every learning doc (roadmaps, "learners",
// "MDN Learn…"), drowning out (or faking) relevance. So we split tokens into
// generic learning words vs. specific topic words, require a specific-word match
// for inclusion, and rank by a relevance score. If the query carries no specific
// topic term, we return [] rather than guess — no unrelated links.
//
// WHY FULL-TEXT SEARCH AND NOT ILIKE. This lane used to fetch a fixed slice of
// substring matches and rank them in JavaScript. Two things were wrong with that,
// and only one of them was a tuning problem:
//
//   1. The slice was ARBITRARY. `LIMIT 48` with no ORDER BY returns whichever 48
//      rows Postgres reaches first, so all the careful scoring below ranked a
//      random sample of the matches. At seed-corpus size the sample was usually
//      the whole set and the bug was invisible; it becomes silent, unfixable recall
//      loss the moment the corpus outgrows the pool. Ranking now happens in SQL,
//      so the pool is the TOP-N by relevance rather than the first N encountered.
//   2. `%data%` is a character sequence, not a word. It matched "database",
//      "metadata" and "update" — which is precisely what the two-specific-term
//      floor and the 60% relative cutoff below were compensating for. A tsquery
//      for `data` matches the word `data`, and matches "analysts" for `analyst`
//      because the 'english' configuration stems both sides. Fewer false
//      positives AND better recall, from the same change.
//
// The scoring SHAPE is deliberately preserved: specific terms weigh 3x generic /
// context terms, and length is damped logarithmically. ts_rank_cd's normalization
// flag 1 divides by 1 + log(length), which is the same curve the hand-written
// normalizer implemented — so this is the same policy, computed where the data is.

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

// --- tsquery construction ------------------------------------------------------
// Terms reach here already reduced to [a-z0-9]+ by tokenize(); contextTerms come
// from the profile and are normalized the same way rather than trusted. That is
// what makes the interpolation below safe to read: a term can never carry tsquery
// operators (`&`, `|`, `!`, `:*`, parentheses), so the query shape is ours alone.
// Terms are still bound as parameters, not concatenated into SQL.
function ftsTerms(terms: string[]): string[] {
  return [...new Set(terms.flatMap((t) => t.toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean))];
}

// Any-of. Inclusion is decided by the specific-hit floor below, not by the tsquery,
// so ORing keeps the candidate pool wide and lets ranking do the discriminating.
function anyOf(terms: string[]): SQL {
  return sql`to_tsquery('english', ${terms.join(" | ")})`;
}

// How many of `terms` this passage contains, counted per term and stem-aware in
// the database. Deliberately DISTINCT-term counting, not ts_rank: rank returns one
// blended number in which "matches one term ten times" and "matches two terms once"
// are hard to tell apart, and both the floor and the weighting below depend on
// telling them apart. Repetition is not evidence of relevance; coverage is.
function hitsExpr(terms: string[]): SQL<number> {
  const parts = terms.map(
    (t) => sql`(${documentChunks.searchVector} @@ to_tsquery('english', ${t}))::int`
  );
  return sql<number>`(${sql.join(parts, sql` + `)})`;
}

// Relevance score. Specific (topic) matches weigh 3x; generic learning words and
// context terms (profile skills / career goal) nudge the ranking but never grant
// inclusion on their own — the floor is counted only over specific terms.
//
// The ts_rank_cd term is a bounded TIE-BREAKER, not the ranking. Coverage counting
// makes every passage matching the same terms score identically, and among those,
// the one where the terms actually cluster together is the better passage to ground
// on. Normalization flag 32 maps the rank to rank/(rank+1), so it is strictly < 1
// and can never outweigh even a single generic-term hit — density refines the order
// within a coverage tier and never reorders across tiers.
//
// Length normalization is applied last, in SQL, on the same curve the previous
// in-process implementation used (chars relative to the target chunk size — NOT
// ts_rank's own flag 1, which normalizes by raw lexeme count and penalizes a long
// passage several times harder than this corpus's chunking warrants).
//
// THE BIAS IT CORRECTS: a longer passage has more chances to contain more distinct
// terms for no better reason than its size. Left uncorrected, chunking makes this
// worse rather than better — a document split into one 1200-char chunk and one
// 250-char chunk would systematically surface the long one even when the short one
// is squarely on topic. Sub-linear rather than dividing by raw length, because
// dividing over-corrects hard the other way: it makes a 30-character fragment
// containing one term outrank a well-argued paragraph containing three, and the
// fragment is the worse passage to ground an answer on even though it is denser.
function scoreExpr(specific: string[], auxiliary: string[]): SQL<number> {
  const coverage =
    auxiliary.length === 0
      ? sql<number>`(3 * ${hitsExpr(specific)})`
      : sql<number>`(3 * ${hitsExpr(specific)} + ${hitsExpr(auxiliary)})`;
  const density = sql<number>`ts_rank_cd(${documentChunks.searchVector}, ${anyOf([...specific, ...auxiliary])}, 32)`;
  return sql<number>`((${coverage} + ${density}) / (1 + ln(1 + length(${documentChunks.content})::float8 / ${TARGET_CHUNK_CHARS})))`;
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

// Visibility — who is allowed to see which documents. Separated from relevance
// because the two are answered by different rows: ownership and linkability are
// properties of the DOCUMENT, topicality is a property of the CHUNK. Both halves of
// hybrid search apply exactly this predicate, which is what guarantees the semantic
// lane cannot become a way around the cross-user boundary the lexical lane enforces.
//
// `globalHttpOnly` restricts to curated, linkable rows (global + real http URL) for
// the resource/course tools.
function visibilityWhere(globalHttpOnly: boolean, ownerId: string | undefined) {
  if (globalHttpOnly) {
    return and(isNull(documents.userId), ilike(documents.sourceUrl, "http%"));
  }
  // A query may retrieve GLOBAL curated docs plus the requesting user's OWN
  // documents (e.g. their uploaded resume), but never another user's. With no
  // ownerId, only global docs are visible.
  return ownerId
    ? or(isNull(documents.userId), eq(documents.userId, ownerId))
    : isNull(documents.userId);
}

// A ranked candidate from either half of the search. `key` is the DOCUMENT id —
// the unit both lanes agree on and the unit fusion must work in, since the same
// document can surface through a different passage in each lane.
type Candidate = {
  key: string;
  id: string;
  type: string;
  documentContent: string;
  chunkContent: string;
  sourceUrl: string | null;
};

// --- Lexical half --------------------------------------------------------------
// Unchanged in behaviour from the full-text-search step: term coverage, the
// specific-hit floor, per-document dedup, the relative cutoff. It is factored out
// rather than rewritten precisely so that adding the semantic half cannot weaken
// the abstention guarantee this lane is responsible for.
async function lexicalCandidates(
  query: string,
  limit: number,
  contextTerms: string[],
  visibility: ReturnType<typeof visibilityWhere>
): Promise<Candidate[]> {
  const keywords = tokenize(query);
  if (keywords.length === 0) return [];

  // A document must match a SPECIFIC topic term. If the query has none (only
  // generic learning words), there is no topic to be relevant to -> return [].
  const specificArr = ftsTerms(keywords.filter((w) => !GENERIC_TERMS.has(w)));
  if (specificArr.length === 0) return [];

  // Generic query words plus profile context terms. Both rank, neither admits.
  const auxiliary = ftsTerms([
    ...keywords.filter((w) => GENERIC_TERMS.has(w)),
    ...contextTerms,
  ]).filter((t) => !specificArr.includes(t));

  const score = scoreExpr(specificArr, auxiliary);
  const specificHits = hitsExpr(specificArr);

  // Topic matching moves to the chunk. Ownership and linkability stay on the
  // document — they are properties of the source, not of a passage — which is why
  // this is a join rather than a lookup: the row that decides VISIBILITY and the
  // row that decides RELEVANCE are no longer the same row.
  //
  // This any-of match is logically implied by the specific-hit floor applied below
  // (>= 1 hit is weaker than >= minHits), but it is kept as a separate predicate
  // because it is the INDEXABLE one: GIN can answer `search_vector @@ tsquery`,
  // and cannot answer a sum of per-term casts. It narrows the scan; the floor then
  // decides admission.
  const topicMatch = sql`${documentChunks.searchVector} @@ ${anyOf(specificArr)}`;

  // ORDER BY is the point of this query, not a nicety. Ranking in SQL is what makes
  // the pool the top-N MATCHES rather than the first N rows the scan happens to
  // reach, which is the difference between a bounded pool and a random sample.
  //
  // The pool stays larger than `limit`: the floor and the per-document dedup below
  // both discard rows, so the pool has to over-fetch to still yield `limit` distinct
  // sources — and one document can contribute many chunks.
  //
  // The floor is applied to the RAW hit count, deliberately not to the score. It
  // asks a yes/no question about topicality — "does this passage contain at least
  // two of the query's specific terms?" — and length has no bearing on that.
  // Applying it to the length-normalized score would let a short chunk fail the
  // floor purely for being short, which is the opposite of what the floor is for.
  //
  // Absolute floor FIRST (is this passage about the subject at all?), then the
  // relative cutoff below (is it among the better answers?). Order matters: the
  // relative step is measured against the surviving best, so a corpus that has
  // nothing on topic yields an empty result rather than a confidently ranked list
  // of near-misses.
  const minHits = requiredSpecificHits(specificArr.length);
  const scored = await db
    .select({
      id: documents.id,
      type: documents.type,
      documentContent: documents.content,
      chunkContent: documentChunks.content,
      sourceUrl: documents.sourceUrl,
      score: score.as("score"),
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    .where(and(visibility, topicMatch, sql`${specificHits} >= ${minHits}`))
    .orderBy(sql`${score} DESC`)
    .limit(Math.max(limit * 12, 48));

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
  for (const row of scored) {
    if (!bestPerDocument.has(row.id)) bestPerDocument.set(row.id, row);
  }
  const deduped = [...bestPerDocument.values()];

  // Relative relevance cutoff: keep only documents scoring within 60% of the best
  // match. This drops incidental single-term hits (e.g. a query for "web
  // development" grazing a passage that mentions "web apps" in passing) while
  // keeping genuinely on-topic results — which match more of the query's specific
  // terms, more densely, and therefore rank higher.
  const cutoff = Number(deduped[0].score) * 0.6;
  return deduped
    .filter((x) => Number(x.score) >= cutoff)
    .slice(0, limit)
    .map((x) => ({ key: x.id, ...x }));
}

// --- Semantic half -------------------------------------------------------------
// Nearest neighbours of the query's embedding, under the SAME visibility predicate
// as the lexical lane.
//
// THE ABSOLUTE SIMILARITY FLOOR IS THE LOAD-BEARING PART. A nearest-neighbour search
// always succeeds: ask a corpus about a subject it has never heard of and it will
// still hand back its closest guess, ranked with total confidence. That is precisely
// the failure the lexical lane's specific-term floor was built to prevent — a query
// about cyber security returning Azure pages — and adding an unfloored vector lane
// would reintroduce it through the back door, in a form that is harder to see
// because the results look semantically plausible.
//
// So similarity here is judged ABSOLUTELY, never relatively: a passage must be
// genuinely close to the question, not merely the closest thing available. Below the
// floor the correct answer is nothing at all.
//
// MEASURED, NOT CHOSEN. Cosine similarity has no absolute meaning independent of the
// embedding model, so this value was read off the corpus with `npm run probe:floor`
// (voyage-3.5-lite, 2026-07-21). Top similarity per query:
//
//   COVERED    "make my CV stand out"            0.5914
//              "keep getting rejected"           0.5904
//              "get into analytics"              0.5818
//              "build websites"                  0.5633
//              "worth changing fields at 30?"    0.3834   <- see below
//   UNCOVERED  "commercial airline pilot"        0.4404
//              "torn meniscus"                   0.3507
//              "cyber security jobs"             0.3194
//
// 0.50 sits in the gap between the highest false positive (0.4404) and the lowest
// clean true positive (0.5633).
//
// THE KNOWN COST, stated rather than hidden: "is it worth changing fields at 30?"
// is genuinely covered by the career-switching document and scores 0.3834 — BELOW
// the airline-pilot false positive. No threshold admits it without also admitting
// the pilot query, so this floor loses it. That is the deliberate trade: an oblique
// question going unanswered is recoverable (the user rephrases), while confidently
// grounding career advice in a document about a different field is not.
//
// RE-DERIVE THIS when the embedding model changes, or when the corpus grows enough
// that the covered/uncovered sets in the probe stop being representative. Do not
// nudge it to make a single query work.
const SEMANTIC_FLOOR = 0.5;

// Reciprocal Rank Fusion constant. 60 is the value from the original RRF paper and
// the de-facto default. What it controls is how sharply rank 1 dominates rank 2:
// large K flattens the curve so the two lanes contribute more evenly, small K makes
// each lane's top hit nearly decisive. It is deliberately not tuned here — with two
// lanes and single-digit result counts, any K in the tens behaves the same, and a
// hand-picked value would be fitted to the seed corpus rather than to retrieval.
const RRF_K = 60;

// How much profile context is allowed to move the semantic ordering.
//
// The lexical lane's rule for context terms is "both rank, neither admits": they
// nudge the order and can never grant inclusion, because the floor is counted only
// over specific terms. This is the same rule expressed in cosine units — admission
// stays governed by similarity to the QUERY alone (SEMANTIC_FLOOR, below), and this
// weight applies only to the ordering of passages already admitted.
//
// THE VALUE IS READ OFF THE DATA, not reasoned to. The blend ranks by
// simQuery + W * simContext, so two passages swap exactly when their query gap is
// smaller than W times their context gap. Context gaps are a property of the model
// and the corpus, so the useful range for W is measured — `npm run probe:context`.
//
// What that probe reports on the current corpus:
//
//   query gap 0.0060  ->  swaps at W > 0.082   (W = 0.1 ACTS)
//   query gap 0.0188  ->  swaps at W > 1.051   (W = 0.1 does nothing)
//
// So 0.1 sits in a wide, clean band: it resolves a 0.006 near-tie, and the nearest
// pair it declines to touch would need a W more than ten times larger. Its effective
// reach is ~0.007 in query-similarity — an order of magnitude below the 0.06 margin
// the floor itself was probed to (0.4404 highest false positive, 0.50 floor). Context
// breaks ties the query cannot resolve; it cannot override the query.
//
// RE-DERIVE THIS when the embedding model changes or the corpus grows substantially,
// for the same reason SEMANTIC_FLOOR carries that instruction. Do not nudge it to
// make a single query rank the way you expected.
//
// KNOWN AND STATED: on the seed corpus this weight is nearly inert in the way that
// matters most — opposite profiles (data vs web) rank the admitted documents the SAME
// way, because a document about choosing skills is more profile-adjacent than one
// about switching fields for anyone with skills. The mechanism is correct and safe;
// its personalization value arrives with a larger `documents` table, not before.
const CONTEXT_WEIGHT = 0.1;

async function semanticCandidates(
  query: string,
  limit: number,
  contextTerms: string[],
  visibility: ReturnType<typeof visibilityWhere>
): Promise<Candidate[]> {
  // One joined string rather than a vector per term: the terms describe a single
  // person (their skills, goal, current role), and their centroid is what "this
  // user's situation" means. Embedding each separately and averaging would cost N
  // round trips to land in nearly the same place.
  const contextText = contextTerms.join(", ");

  // Concurrent, and the context call is skipped entirely when there is no profile
  // context — an empty string short-circuits inside embedQuery, so a user without a
  // profile pays nothing and gets exactly today's behaviour.
  const [vector, contextVector] = await Promise.all([
    embedQuery(query),
    contextText ? embedQuery(contextText) : Promise.resolve(null),
  ]);
  // No key, provider down, or an empty query — the caller runs lexical-only.
  if (!vector) return [];

  // pgvector's text input form. Bound as a parameter and cast, never interpolated:
  // the cast is what lets the planner use the HNSW index, and `<=>` must be the
  // operator (cosine distance) because the index was built with vector_cosine_ops.
  const literal = sql`${`[${vector.join(",")}]`}::vector`;
  const distance = sql<number>`(${documentChunks.embedding} <=> ${literal})`;

  // Context distance is SELECTed but never ORDERed by. That is deliberate: ORDER BY
  // on the query distance alone is what the HNSW index can answer, and blending the
  // two in SQL would turn every retrieval into a sequential scan. The blend happens
  // in process, over the already-bounded pool, where it also stays legible.
  //
  // A null context vector selects a constant so the row shape does not change —
  // the ranking below then treats every passage as equally context-neutral.
  const contextDistance = contextVector
    ? sql<number>`(${documentChunks.embedding} <=> ${sql`${`[${contextVector.join(",")}]`}::vector`})`
    : sql<number>`1`;

  const rows = await db
    .select({
      id: documents.id,
      type: documents.type,
      documentContent: documents.content,
      chunkContent: documentChunks.content,
      sourceUrl: documents.sourceUrl,
      distance: distance.as("distance"),
      contextDistance: contextDistance.as("context_distance"),
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    // `embedding IS NOT NULL` is not redundant: a chunk written while embeddings
    // were unavailable has no vector, and pgvector sorts NULL distances last rather
    // than excluding them — without this they would pad the pool and push real
    // neighbours out of it.
    .where(and(visibility, isNotNull(documentChunks.embedding)))
    .orderBy(distance)
    .limit(Math.max(limit * 6, 24));

  // Cosine distance -> cosine similarity. Done here rather than in SQL so the floor
  // is expressed in the units it is reasoned about in.
  //
  // ADMISSION USES simQuery ONLY. Context is not part of this test and must never
  // become part of it: a passage that is merely adjacent to the user's background,
  // while saying nothing about what they asked, is exactly the confident-but-wrong
  // grounding the floor exists to refuse.
  const above = rows
    .filter((r) => 1 - Number(r.distance) >= SEMANTIC_FLOOR)
    .map((r) => ({
      ...r,
      rank:
        1 -
        Number(r.distance) +
        CONTEXT_WEIGHT * (1 - Number(r.contextDistance)),
    }))
    .sort((a, b) => b.rank - a.rank);

  // Same per-document dedup as the lexical lane, for the same reason: `limit` must
  // mean distinct sources. Rows are ranked before this, so the first occurrence of
  // a document is its best passage.
  const best = new Map<string, (typeof above)[number]>();
  for (const row of above) {
    if (!best.has(row.id)) best.set(row.id, row);
  }
  return [...best.values()].slice(0, limit).map((x) => ({ key: x.id, ...x }));
}

// --- Fusion --------------------------------------------------------------------
// Reciprocal Rank Fusion: each lane contributes 1/(K + rank) for every document it
// ranked, and the sums decide the final order.
//
// RANK, NOT SCORE, IS THE WHOLE POINT. The lexical lane produces term-coverage
// numbers in the single digits and the semantic lane produces cosine similarities in
// [0,1]; there is no principled way to add those, and every attempt to (normalize
// them, weight them, min-max them) ends up fitting constants to whichever corpus was
// on hand. Ranks are comparable by construction, so fusion needs no calibration and
// stays correct as the corpus grows.
//
// A document found by BOTH lanes rises above one found by either alone — which is
// the useful signal here: lexical and semantic agreement is real corroboration,
// since the two lanes fail in unrelated ways.
function fuse(lanes: Candidate[][], limit: number): Candidate[] {
  const scores = new Map<string, number>();
  const rows = new Map<string, Candidate>();

  for (const lane of lanes) {
    lane.forEach((row, i) => {
      scores.set(row.key, (scores.get(row.key) ?? 0) + 1 / (RRF_K + i + 1));
      // First lane to surface a document supplies the passage that will be
      // returned. Lexical is passed first, so a document found by both is
      // represented by its keyword-matching passage — the one that actually
      // contains the user's words, which is the better evidence to quote.
      if (!rows.has(row.key)) rows.set(row.key, row);
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => rows.get(key)!);
}

// Shared hybrid retrieval, matched at CHUNK granularity.
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
async function retrieve(
  query: string,
  limit: number,
  contextTerms: string[],
  globalHttpOnly: boolean,
  ownerId: string | undefined,
  returnPassage: boolean
): Promise<RetrievedDocument[]> {
  const visibility = visibilityWhere(globalHttpOnly, ownerId);

  // Run both lanes concurrently: the semantic one spends most of its time waiting
  // on the embedding provider, and serializing them would add that latency to every
  // retrieval for no benefit — neither lane's input depends on the other's output.
  const [lexical, semantic] = await Promise.all([
    lexicalCandidates(query, limit, contextTerms, visibility),
    semanticCandidates(query, limit, contextTerms, visibility),
  ]);

  return fuse([lexical, semantic], limit).map((x) => ({
    // The DOCUMENT's id, not the chunk's. Everything downstream — sources_used,
    // the trace, dedup by caller — identifies evidence by document, and handing
    // back a chunk id would silently break that correspondence.
    id: x.id,
    type: x.type,
    content: returnPassage ? x.chunkContent : x.documentContent,
    sourceUrl: x.sourceUrl,
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
