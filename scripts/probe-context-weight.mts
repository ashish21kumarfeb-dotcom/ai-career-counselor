// Calibration tool for CONTEXT_WEIGHT in src/lib/documents/queries.ts.
//
// That constant decides how much a user's profile is allowed to reorder passages the
// QUERY has already admitted. Like SEMANTIC_FLOOR, it cannot be reasoned to from
// first principles — it is a ratio between two similarity spreads that are both
// properties of the model and the corpus — so it has to be read off the data.
//
// WHAT IT CANNOT AFFECT, stated so this probe is not mistaken for a safety check:
// admission is decided by similarity to the query alone, before the blend is applied.
// No value of W admits a document. The risk W carries is therefore not abstention but
// DISTORTION: a large W pulls a passage the query ranks lower above one it ranks
// higher, purely because it resembles the user's background.
//
// So there are two numbers to find, and the useful range is between them:
//
//   REQUIRED W  — the smallest W that reorders anything at all. Below this the
//                 constant is decorative: the code runs, costs an embedding call per
//                 retrieval, and changes no output.
//   DISTORTION  — for a candidate W, the largest query-similarity gap it can cross.
//                 This is what "context breaks near-ties" has to mean numerically.
//
// If REQUIRED W is large enough that acting on it would cross wide query gaps, the
// honest conclusion is that this corpus has no near-ties to break and the blend
// should not ship — not that W should be raised until something moves.
//
//   npm run probe:context
import "dotenv/config";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../src/db";
import { documentChunks, documents } from "../src/db/schema";
import { embedQuery, embeddingsEnabled } from "../src/lib/ai/embeddings";

// Keep in sync with SEMANTIC_FLOOR in src/lib/documents/queries.ts. Duplicated rather
// than imported because that module is not exported for probing, and a probe reading
// a different floor than production would calibrate against a different admitted set.
const SEMANTIC_FLOOR = 0.5;

// Deliberately BROAD and field-neutral. A query that names a field ranks itself, and
// the profile has nothing left to contribute — so such a query would prove nothing
// about W either way. These are the queries where context is supposed to matter.
const QUERIES = [
  "what should I learn next to move forward in my career?",
  "how do I get better at what I do?",
  "what is a good next step for me professionally?",
];

// Two backgrounds with as little overlap as this corpus allows. If context cannot
// separate these, it cannot separate anything.
const PROFILES = [
  { name: "data", terms: ["SQL", "Excel", "data analysis", "dashboards", "business intelligence"] },
  { name: "web", terms: ["JavaScript", "React", "CSS", "frontend", "building websites"] },
];

if (!embeddingsEnabled()) {
  console.error("VOYAGE_API_KEY is not set — nothing to probe.");
  process.exit(1);
}

const PACE_MS = 21_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Same pacing rationale as probe-semantic-floor: a probe that silently drops half its
// requests calibrates on whichever half got through.
const embedded = new Set<string>();
async function embed(text: string): Promise<number[] | null> {
  if (!embedded.has(text)) {
    if (embedded.size > 0) await sleep(PACE_MS);
    embedded.add(text);
  }
  return embedQuery(text);
}

const asVector = (v: number[]) => sql`${`[${v.join(",")}]`}::vector`;

// The admitted set for one query, ranked by query similarity, with each document's
// similarity to the profile alongside. Mirrors production: per-document dedup keeping
// the closest passage, then the floor.
async function admittedSet(queryVec: number[], contextVec: number[]) {
  const qd = sql<number>`(${documentChunks.embedding} <=> ${asVector(queryVec)})`;
  const cd = sql<number>`(${documentChunks.embedding} <=> ${asVector(contextVec)})`;

  const rows = await db
    .select({
      url: documents.sourceUrl,
      qd: qd.as("qd"),
      cd: cd.as("cd"),
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    .where(and(isNotNull(documentChunks.embedding), sql`${documents.userId} is null`))
    .orderBy(qd);

  const best = new Map<string, { url: string; simQ: number; simC: number }>();
  for (const r of rows) {
    const url = r.url ?? "";
    if (best.has(url)) continue;
    best.set(url, { url, simQ: 1 - Number(r.qd), simC: 1 - Number(r.cd) });
  }
  return [...best.values()].filter((d) => d.simQ >= SEMANTIC_FLOOR);
}

// The smallest W that would swap some adjacent pair.
//
// Ranking is simQ + W * simC. Two neighbours i (higher on the query) and i+1 swap
// exactly when W * (simC[i+1] - simC[i]) > (simQ[i] - simQ[i+1]) — that is, when the
// profile prefers the lower-ranked document by enough to overcome the query's
// preference. A pair the profile ranks the same way as the query can never swap, at
// any W, which is the property that makes this bounded rather than a slider.
function requiredWeights(docs: { url: string; simQ: number; simC: number }[]) {
  const out: { pair: string; gapQ: number; gapC: number; needs: number }[] = [];
  for (let i = 0; i < docs.length - 1; i++) {
    const a = docs[i];
    const b = docs[i + 1];
    const gapQ = a.simQ - b.simQ;
    const gapC = b.simC - a.simC;
    if (gapC <= 0) continue; // profile agrees with the query — unswappable
    out.push({ pair: `${short(b.url)} over ${short(a.url)}`, gapQ, gapC, needs: gapQ / gapC });
  }
  return out.sort((x, y) => x.needs - y.needs);
}

const short = (u: string) => u.replace("internal-seed/", "").replace(/^https?:\/\//, "");

console.log(`\nPacing ${PACE_MS / 1000}s between embedding requests to stay inside the rate limit.`);

const allRequired: number[] = [];
let incomplete = false;

for (const query of QUERIES) {
  const qVec = await embed(query);
  if (!qVec) {
    console.log(`\n"${query}"\n   (query embedding failed — excluded)`);
    incomplete = true;
    continue;
  }

  console.log(`\n===== "${query}" =====`);

  for (const profile of PROFILES) {
    const cVec = await embed(profile.terms.join(", "));
    if (!cVec) {
      console.log(`   [${profile.name}] (context embedding failed — excluded)`);
      incomplete = true;
      continue;
    }

    const docs = await admittedSet(qVec, cVec);
    console.log(`\n   [${profile.name}] ${docs.length} admitted`);
    for (const d of docs) {
      console.log(`      simQ ${d.simQ.toFixed(4)}   simC ${d.simC.toFixed(4)}   ${short(d.url)}`);
    }

    const needs = requiredWeights(docs);
    if (needs.length === 0) {
      console.log("      no swappable pair: the profile ranks these the same way the query does.");
      continue;
    }
    for (const n of needs) {
      console.log(
        `      W > ${n.needs.toFixed(3)} would put ${n.pair}` +
          `   (query gap ${n.gapQ.toFixed(4)}, context gap ${n.gapC.toFixed(4)})`
      );
    }
    allRequired.push(needs[0].needs);
  }
}

console.log("\n===== summary =====");

if (incomplete) {
  console.error(
    "\nIncomplete: at least one embedding request failed, so some queries or profiles\n" +
      "are missing from the sample above. Re-run rather than calibrating on the part\n" +
      "that got through."
  );
  process.exit(1);
}

if (allRequired.length === 0) {
  console.log(
    "\nNO SWAPPABLE PAIR ANYWHERE in this sample. For every admitted set, the profile\n" +
      "ordered the documents the same way the query already did. No value of W changes\n" +
      "any output — the blend is inert on this corpus, and shipping it would add an\n" +
      "embedding call per retrieval to buy nothing."
  );
  process.exit(0);
}

const smallest = Math.min(...allRequired);
console.log(`\nSmallest W that reorders anything: ${smallest.toFixed(3)}`);
console.log(
  `A candidate W must exceed ${smallest.toFixed(3)} to do anything at all.\n` +
    "Judge it against the query gaps printed above: if the pairs it would swap are\n" +
    "separated by a query gap comparable to the floor's own margin (0.06 between the\n" +
    "highest false positive at 0.4404 and the floor at 0.50), then W is not breaking\n" +
    "near-ties — it is overriding the query, and the blend should not ship."
);
console.log();
