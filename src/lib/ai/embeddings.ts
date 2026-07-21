// Voyage AI embedding client — the semantic half of hybrid retrieval.
//
// WHY A SEPARATE PROVIDER FROM THE CHAT MODEL. Groq serves the chat and intent
// models but has no production embeddings endpoint, so the two cannot be the same
// vendor. Voyage is the one added here; the surface below is deliberately narrow
// (two functions, one shape) so swapping providers means rewriting this file and
// re-running the backfill, not touching retrieval.
//
// WHY PLAIN FETCH AND NOT AN SDK. The entire API used is one POST returning one
// array. An SDK would add a dependency, a version to track and a bundling
// surface, and would hide the two things that actually matter here: that the
// call is bounded by a timeout, and that a failure degrades rather than throws.
//
// DEGRADATION IS THE CONTRACT. Every function here returns null (or an array of
// nulls) rather than throwing when embeddings are unavailable — no API key, a 5xx,
// a timeout. Retrieval is designed to run lexically-only in that case, so an
// embeddings outage costs recall on paraphrased queries and nothing else. The
// alternative — propagating the error — would turn a degraded search into a failed
// chat request, which is a far worse trade for advice the user is waiting on.
import { EMBEDDING_DIMENSIONS } from "../../db/schema";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

// voyage-3.5-lite: the small tier of Voyage's current general-purpose family.
// Chosen over the full voyage-3.5 because this corpus is short career documents
// where the quality gap is small and the cost/latency gap is not. Override with
// VOYAGE_MODEL if that stops being true — but note that switching to a model with
// a different native dimension also requires changing EMBEDDING_DIMENSIONS, a
// migration, and a full re-embed.
export const EMBEDDING_MODEL = process.env.VOYAGE_MODEL ?? "voyage-3.5-lite";

// Voyage distinguishes the two sides of a retrieval pair and prepends a different
// instruction to each. This is not cosmetic: a stored passage and the question that
// should find it are different KINDS of text — one answers, one asks — and
// embedding both as if they were the same kind measurably weakens the match. Using
// the wrong side here is a silent quality regression with no error to notice, which
// is why the two entry points below are separate functions rather than a flag a
// caller can forget.
type InputType = "document" | "query";

const TIMEOUT_MS = 15_000;

// A batch cap on the request, not on the corpus: callers hand over as many texts as
// they have and this module slices. Voyage's per-request limit is well above this,
// but a smaller batch bounds the blast radius of one failed request — with the
// whole corpus in a single call, one timeout loses every embedding.
const BATCH_SIZE = 64;

export function embeddingsEnabled(): boolean {
  return Boolean(process.env.VOYAGE_API_KEY);
}

type VoyageResponse = {
  data?: Array<{ embedding?: number[]; index?: number }>;
};

// How long a caller is willing to spend waiting out a 429, in total across retries.
//
// The two sides have genuinely different economics, which is why this is a budget
// per call site rather than one retry policy:
//   - A QUERY is on a user's critical path. They are waiting for career advice, and
//     making them wait 30 extra seconds to slightly improve retrieval is a bad
//     trade — degrading to lexical-only after a brief retry is the better answer.
//   - A DOCUMENT is a background write or a backfill. Nobody is watching, and the
//     cost of giving up is a permanently half-visible corpus, so patience is nearly
//     free and abandoning is expensive.
//
// Voyage's free tier allows only a few requests per minute, so on that tier the
// document budget is what makes a backfill of any size complete at all.
const RETRY_BUDGET_MS: Record<InputType, number> = {
  query: 2_000,
  document: 90_000,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How long to wait before retrying a 429. Prefers the server's own Retry-After —
// it knows when the window resets and guessing shorter just burns another request
// against the same limit — and falls back to exponential backoff when absent.
function retryDelayMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000 + 250, 60_000);
  return Math.min(1_000 * 2 ** attempt, 20_000);
}

// One logical request, retried while rate-limited within the budget. Returns null
// for the whole batch on any failure — the caller treats that as "no embeddings this
// time", never as "these texts have no meaning".
async function embedBatch(texts: string[], inputType: InputType): Promise<(number[] | null)[]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return texts.map(() => null);

  let spentMs = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(VOYAGE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          input: texts,
          model: EMBEDDING_MODEL,
          input_type: inputType,
          // Asked for explicitly rather than accepting the default, so a provider-side
          // default change cannot quietly start returning vectors the column rejects.
          output_dimension: EMBEDDING_DIMENSIONS,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      // 429 is the one status worth waiting out: it says "ask again later", not
      // "this will not work". Every other error is returned as-is — retrying a 401
      // or a 400 just burns the budget to arrive at the same answer.
      if (res.status === 429) {
        const wait = retryDelayMs(res, attempt);
        if (spentMs + wait > RETRY_BUDGET_MS[inputType]) {
          console.warn(
            `[embeddings] rate limited; ${inputType} retry budget exhausted after ${(spentMs / 1000).toFixed(1)}s — falling back to lexical-only`
          );
          return texts.map(() => null);
        }
        console.warn(`[embeddings] rate limited; retrying in ${(wait / 1000).toFixed(1)}s`);
        await sleep(wait);
        spentMs += wait;
        continue;
      }

      if (!res.ok) {
        console.warn(
          `[embeddings] ${EMBEDDING_MODEL} returned ${res.status}; falling back to lexical-only`
        );
        return texts.map(() => null);
      }

      const body = (await res.json()) as VoyageResponse;
      // The response is ordered by `index`, not by arrival, and the API is explicit
      // that callers must not assume input order. Reassembling by index is what keeps
      // an embedding attached to the text it was computed from — getting this wrong
      // produces a corpus that is fully populated, entirely wrong, and passes every
      // test that only checks for non-null.
      const out: (number[] | null)[] = texts.map(() => null);
      for (const item of body.data ?? []) {
        const at = item.index ?? -1;
        if (at < 0 || at >= texts.length) continue;
        const vec = item.embedding;
        if (Array.isArray(vec) && vec.length === EMBEDDING_DIMENSIONS) out[at] = vec;
      }
      return out;
    } catch (err) {
      console.warn(
        `[embeddings] request failed (${(err as Error).message}); falling back to lexical-only`
      );
      return texts.map(() => null);
    }
  }
}

// Embed stored passages. Result is index-aligned with `texts`; entries are null
// where the provider failed or returned an unusable vector.
export async function embedDocuments(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  const out: (number[] | null)[] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    out.push(...(await embedBatch(texts.slice(i, i + BATCH_SIZE), "document")));
  }
  return out;
}

// Process-local cache of query embeddings.
//
// A single chat turn retrieves more than once — RAG grounding and the
// resource/course lane both search, usually with the same resolved query — and
// without this each one is a separate paid round trip on the user's critical path.
// Keyed on the exact text, so it is a memo rather than a heuristic: same input,
// same vector, no staleness possible (an embedding of a fixed string with a fixed
// model does not change).
//
// Bounded and FIFO-evicted. A long-lived server process would otherwise accumulate
// one 1024-float array per distinct question ever asked, which is a slow leak that
// only shows up in production.
const QUERY_CACHE_MAX = 500;
const queryCache = new Map<string, number[] | null>();

// Embed a user's question. Null means "search lexically only this time".
export async function embedQuery(text: string): Promise<number[] | null> {
  const key = text.trim();
  if (!key) return null;

  const cached = queryCache.get(key);
  // Distinguishes a cached null from a miss — `undefined` is the only miss.
  if (cached !== undefined) return cached;

  const [vec] = await embedBatch([key], "query");
  const result = vec ?? null;

  // A failure is NOT cached: the next turn should retry rather than inherit a
  // transient timeout for the lifetime of the process.
  if (result) {
    if (queryCache.size >= QUERY_CACHE_MAX) {
      queryCache.delete(queryCache.keys().next().value as string);
    }
    queryCache.set(key, result);
  }
  return result;
}
