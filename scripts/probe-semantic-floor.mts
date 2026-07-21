// Calibration tool for SEMANTIC_FLOOR in src/lib/documents/queries.ts.
//
// That constant is the single thing standing between hybrid retrieval and the
// failure mode vector search is prone to: confidently returning the nearest thing
// in the corpus to a subject the corpus does not cover. It cannot be reasoned to
// from first principles — cosine similarity has no absolute meaning independent of
// the embedding model — so it has to be READ OFF THE DATA, and re-read whenever the
// model changes.
//
// What to look for: the printed similarities for COVERED queries should sit clearly
// above those for UNCOVERED ones. Put the floor in the gap. If there is no gap, the
// floor cannot do its job and the honest response is to keep the semantic lane
// narrow rather than to pick a number that splits the difference.
//
//   npm run probe:floor
import "dotenv/config";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../src/db";
import { documentChunks, documents } from "../src/db/schema";
import { embedQuery, embeddingsEnabled } from "../src/lib/ai/embeddings";

// Queries the seeded corpus genuinely covers, phrased so the LEXICAL lane would
// struggle — the whole point of the semantic lane is these.
const COVERED = [
  "I want to build websites",
  "how do I make my CV stand out to employers?",
  "what should I do to get into analytics?",
  "I keep getting rejected after interviews",
  "is it worth changing fields at 30?",
];

// Subjects the corpus does NOT cover. Their best neighbour is by definition a false
// positive, and its similarity is the number the floor has to sit above.
const UNCOVERED = [
  "what is the current market scope for cyber security jobs?",
  "how do I become a commercial airline pilot?",
  "best treatment for a torn meniscus",
];

if (!embeddingsEnabled()) {
  console.error("VOYAGE_API_KEY is not set — nothing to probe.");
  process.exit(1);
}

async function topMatches(query: string, n = 3) {
  const vector = await embedQuery(query);
  if (!vector) return [];
  const literal = sql`${`[${vector.join(",")}]`}::vector`;
  const distance = sql<number>`(${documentChunks.embedding} <=> ${literal})`;
  const rows = await db
    .select({
      sourceUrl: documents.sourceUrl,
      distance: distance.as("distance"),
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    .where(and(isNotNull(documentChunks.embedding), sql`${documents.userId} is null`))
    .orderBy(distance)
    .limit(n);
  return rows.map((r) => ({ url: r.sourceUrl ?? "", sim: 1 - Number(r.distance) }));
}

// Voyage's free tier allows only a few requests per minute, and each query here is
// its own request. The client retries a 429, but on a short budget for `query`
// input — correctly, since that budget is sized for a user waiting on an answer, not
// for a batch script. So this paces itself rather than leaning on the retry: a
// probe that silently drops half its queries produces a threshold calibrated on the
// half that got through, which is worse than no threshold.
const PACE_MS = 21_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function report(label: string, queries: string[], first: boolean): Promise<number[]> {
  console.log(`\n===== ${label} =====`);
  const tops: number[] = [];
  for (const [i, q] of queries.entries()) {
    if (!(first && i === 0)) await sleep(PACE_MS);
    const matches = await topMatches(q);
    console.log(`\n"${q}"`);
    for (const m of matches) console.log(`   ${m.sim.toFixed(4)}  ${m.url}`);
    // A query that produced NO matches was rate limited or failed — it did not
    // "score low". Recording it as a data point would drag the covered minimum
    // down and hand back a floor that lets false positives through.
    if (matches[0]) tops.push(matches[0].sim);
    else console.log("   (no result — request failed; excluded from calibration)");
  }
  return tops;
}

console.log(`\nPacing ${PACE_MS / 1000}s between queries to stay inside the provider's rate limit.`);
const coveredTops = await report("COVERED (should be ABOVE the floor)", COVERED, true);
const uncoveredTops = await report("UNCOVERED (should be BELOW the floor)", UNCOVERED, false);

if (coveredTops.length < COVERED.length || uncoveredTops.length < UNCOVERED.length) {
  console.error(
    `\nIncomplete: ${coveredTops.length}/${COVERED.length} covered and ` +
      `${uncoveredTops.length}/${UNCOVERED.length} uncovered queries returned results.\n` +
      "Calibrating on a partial sample is how a floor ends up fitted to whichever\n" +
      "queries happened to succeed. Re-run rather than trusting the summary below."
  );
  process.exit(1);
}

const worstCovered = Math.min(...coveredTops);
const bestUncovered = Math.max(...uncoveredTops);

console.log("\n===== summary =====");
console.log(`Lowest  top-similarity among COVERED   queries: ${worstCovered.toFixed(4)}`);
console.log(`Highest top-similarity among UNCOVERED queries: ${bestUncovered.toFixed(4)}`);

if (worstCovered > bestUncovered) {
  const mid = (worstCovered + bestUncovered) / 2;
  console.log(`\nSeparation of ${(worstCovered - bestUncovered).toFixed(4)}.`);
  console.log(`A floor anywhere in (${bestUncovered.toFixed(4)}, ${worstCovered.toFixed(4)}) separates them; midpoint ${mid.toFixed(4)}.`);
} else {
  console.log(
    "\nNO SEPARATION: the best uncovered match scores at least as high as the worst\n" +
      "covered one. No single threshold can tell them apart — do not pick one that\n" +
      "merely looks reasonable."
  );
}
console.log();
