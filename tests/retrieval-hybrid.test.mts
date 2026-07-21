// Hybrid-retrieval tests: what the SEMANTIC lane adds, and what it must not break.
//
// Two obligations, and they pull against each other — which is why they are tested
// together rather than in separate files:
//
//   1. RECALL. Queries that mean the same thing as a document but share none of its
//      words ("CV" vs "resume", "build websites" vs "web development") must now
//      retrieve. These are exactly the queries the lexical lane cannot answer, and
//      each case below is asserted to FAIL lexically first — otherwise the test
//      would pass on a system with no embeddings at all and prove nothing.
//
//   2. ABSTENTION. A subject the corpus does not cover must still return NOTHING.
//      Vector search is structurally prone to the opposite: nearest-neighbour always
//      returns its closest guess. This is the guarantee most at risk from Step B and
//      the reason SEMANTIC_FLOOR exists.
//
// Requires DATABASE_URL, VOYAGE_API_KEY, the seeded corpus (npm run seed:documents)
// and embeddings (npm run embeddings:backfill). No LLM.
import "dotenv/config";
import { searchDocuments } from "../src/lib/documents/queries";
import { embeddingsEnabled } from "../src/lib/ai/embeddings";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`);
  }
}

if (!embeddingsEnabled()) {
  // Deliberately an ERROR, not a silent skip. A suite that quietly passes when the
  // thing it tests is switched off is worse than no suite: it reports green for a
  // system running in degraded mode.
  console.error(
    "\nVOYAGE_API_KEY is not set — the semantic lane is disabled, so these tests\n" +
      "cannot verify anything. Set the key and run `npm run embeddings:backfill`.\n"
  );
  process.exit(1);
}

const urlsOf = (rows: { sourceUrl: string | null }[]) => rows.map((r) => r.sourceUrl ?? "");
const has = (urls: string[], s: string) => urls.some((u) => u.toLowerCase().includes(s));

// Voyage's free tier allows only about three requests per minute and each distinct
// query costs one, so the suite paces itself. Without this it rate-limits partway
// through, retrieval silently degrades to lexical-only, and the abstention block
// below passes for the wrong reason.
const PACE_MS = 25_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Pacing is per EMBEDDING REQUEST, not per search. A context-aware search costs two
// requests (the query, plus the centroid of the profile terms), so counting searches
// would let the context cases below quietly outrun the free tier — and a rate-limited
// context case degrades to lexical-only, which is precisely the failure mode this
// suite exists to not report as green.
//
// Repeats are free: embedQuery memoizes on the exact text, so re-searching the same
// query under a second profile costs one request, not two.
const embedded = new Set<string>();
async function pace(...texts: string[]) {
  for (const text of texts) {
    if (!text || embedded.has(text)) continue;
    if (embedded.size > 0) await sleep(PACE_MS);
    embedded.add(text);
  }
}

async function search(query: string, limit: number, contextTerms: string[] = []): Promise<string[]> {
  await pace(query, contextTerms.join(", "));
  return urlsOf(await searchDocuments(query, undefined, limit, contextTerms));
}

// HOW THIS SUITE KNOWS THE SEMANTIC LANE ACTUALLY RAN.
//
// It is not asked directly, and the first two attempts to do so were both wrong.
// Retrieval degrades to lexical-only whenever an embedding call fails, and a
// degraded search returns a perfectly normal-looking result set — so a rate-limited
// run would sail through the abstention assertions, which pass trivially when the
// semantic lane is switched off, and report green for a system that never exercised
// the code under test.
//
// Inspecting the client's query cache from here does NOT work: this file is .mts
// (ESM) while the modules under test are .ts, and the two resolve to separate module
// instances, so the test observes a different cache than retrieval populates. That
// produced a confident-looking check that reported "embeddings unavailable" while
// the semantic lane was demonstrably working.
//
// So liveness is proved BEHAVIOURALLY, by the recall cases below, and they run
// FIRST for exactly that reason. Each one is retrievable ONLY through embeddings —
// verified against the lexical rules, not assumed:
//
//   "how do I make my CV stand out to employers?" -> resume-fundamentals
//       specific terms are {make, stand, employers} ("cv" is under the 3-char
//       minimum). None of the three appears in that document. Lexical hits: 0.
//
//   "I want to build websites" -> roadmap.sh/frontend
//       specific terms are {build, websites}; the document matches "build" via
//       "building" but nothing stems "websites" to "web development". Lexical
//       hits: 1, against a floor of 2.
//
// If embeddings are down, both return [] and this suite fails before it reaches
// anything that could pass for the wrong reason.

// --- 1. Recall the lexical lane cannot reach ------------------------------------
type RecallCase = {
  query: string;
  // The document the query MEANS, named by a fragment of its source URL.
  expect: string;
  // Why the lexical lane misses it — documentation, and it is asserted.
  lexicalGap: string;
};

const RECALL: RecallCase[] = [
  {
    query: "how do I make my CV stand out to employers?",
    expect: "resume-fundamentals",
    lexicalGap: "'CV' never appears in the corpus; the document says 'resume'",
  },
  {
    query: "I want to build websites",
    expect: "frontend",
    lexicalGap: "'websites' does not stem to 'web development'",
  },
];

console.log("\n== the semantic lane retrieves what the lexical lane cannot ==");
for (const c of RECALL) {
  const urls = await search(c.query, 5);
  console.log(`\n[${c.query}]\n  -> ${JSON.stringify(urls)}`);
  check(`[${c.query.slice(0, 30)}…] retrieves the document it means`, has(urls, c.expect), `${JSON.stringify(urls)} (gap: ${c.lexicalGap})`);
}

// --- 2. Abstention survives the semantic lane -----------------------------------
// The same queries the lexical floor already handled. They are re-run here because
// the risk is now different in kind: previously an incidental shared WORD could
// admit a wrong document; now an incidental shared MEANING can. "Cyber security
// jobs" is semantically adjacent to every career document in the corpus — it is a
// question about jobs, and the corpus is entirely about jobs — so it is the sharpest
// available test of whether the floor is set high enough.
console.log("\n== an uncovered subject still returns nothing ==");
for (const query of [
  "What is the current market scope for cyber security jobs?",
  "Is there demand for cyber security roles?",
  "How do I become a commercial airline pilot?",
  "What is the best treatment for a torn meniscus?",
]) {
  const urls = await search(query, 5);
  check(`[${query.slice(0, 38)}…] returns nothing`, urls.length === 0, JSON.stringify(urls));
}

// --- 3. Fusion does not displace a strong lexical match -------------------------
// RRF adds a second lane's opinion; it must not demote a document that is an exact
// keyword match for the question. A regression here would show up as advice quietly
// grounded on a loosely-related passage instead of the on-the-nose one.
console.log("\n== fusion keeps strong lexical matches at the top ==");
{
  const query = "data analyst SQL and Tableau";
  const urls = await search(query, 3);
  console.log(`  -> ${JSON.stringify(urls)}`);
  check("an exact-keyword query still ranks its document first", has(urls.slice(0, 1), "data-analy"), JSON.stringify(urls));
}

// --- 4. Profile context RANKS -----------------------------------------------------
// The contract copied from the lexical lane is "both rank, neither admits". This
// block tests the RANK half: the same question asked by two people with opposite
// backgrounds should surface the same evidence in a different order.
//
// The query is deliberately BROAD and profile-neutral — it names no field, so every
// generic career document is a near-tie on the query alone and the profile is the
// only thing left to break the tie. A query that named a field would rank itself and
// prove nothing about context.
//
// ON SET STABILITY, stated because it is an expectation rather than a guarantee:
// admission in the SEMANTIC lane provably ignores context (the floor is applied to
// simQuery before the blend). The LEXICAL lane is weaker — context terms feed its
// auxiliary score, and its cutoff is RELATIVE (60% of the best match), so a different
// profile shifts the baseline and could in principle move membership. The assertion
// below is therefore the honest one to make and the one worth knowing if it breaks;
// it is not tuned to be green.
//
// THE BASELINE IS NO-CONTEXT, NOT THE OTHER PROFILE — and that distinction is the
// whole reason this block is written the way it is. The obvious test ("two opposite
// profiles must rank differently") was written first and FAILED, which looked like
// the blend doing nothing. `npm run probe:context` showed the opposite: context DID
// reorder, by exactly the amount predicted (a 0.0060 query gap, swappable at
// W > 0.082), but BOTH profiles crossed their threshold and swapped the same pair, so
// comparing them to each other cancelled the effect out. A document about choosing
// skills is more profile-adjacent than one about switching fields for anyone with
// skills, so on this corpus no two profiles disagree.
//
// Comparing against the UNPERSONALIZED ranking measures what the code actually
// promises — that profile context moves the order — instead of a discrimination
// property this corpus cannot exhibit.
console.log("\n== profile context reorders near-ties without changing what is admitted ==");
{
  const query = "what should I learn next to move forward in my career?";
  const DATA_PROFILE = ["SQL", "Excel", "data analysis", "dashboards", "business intelligence"];

  // Same query text, so embedQuery serves it from cache — the baseline is free.
  const noContext = await search(query, 5);
  const asData = await search(query, 5, DATA_PROFILE);
  console.log(`\n[no context]    -> ${JSON.stringify(noContext)}`);
  console.log(`[data profile]  -> ${JSON.stringify(asData)}`);

  const sameSet =
    noContext.length === asData.length &&
    [...noContext].sort().join("|") === [...asData].sort().join("|");

  check(
    "context leaves the admitted document set unchanged",
    sameSet,
    `none=${JSON.stringify([...noContext].sort())} data=${JSON.stringify([...asData].sort())}`
  );
  check(
    "context changes the ranking of that set",
    asData.join("|") !== noContext.join("|"),
    `both ranked ${JSON.stringify(asData)} — context had no effect on order`
  );
}

// --- 5. Profile context does NOT admit ---------------------------------------------
// The ADMIT half of the same contract, and the one that actually protects the user.
//
// The pilot query is the sharpest instrument available: the floor probe recorded it
// at cosine 0.4404, the HIGHEST false positive in this corpus and only 0.06 below
// SEMANTIC_FLOOR. Paired with an aggressively on-corpus profile, it is the document
// most likely to be dragged over the line if context ever leaked into admission.
//
// The failure this forbids is a specific and dangerous one: grounding career advice
// in a document that matches WHO THE USER IS while saying nothing about WHAT THEY
// ASKED. Being adjacent to someone's background is not evidence.
//
// The query text is reused verbatim from the abstention block above so embedQuery
// serves it from cache — the profile centroid is the only new request here.
console.log("\n== strong profile context still cannot admit an unrelated document ==");
{
  const query = "How do I become a commercial airline pilot?";
  const STRONG_CAREER_PROFILE = [
    "career change",
    "job search",
    "resume",
    "interview preparation",
    "professional growth",
  ];

  const urls = await search(query, 5, STRONG_CAREER_PROFILE);
  check(
    "an off-corpus query returns nothing even under maximally on-corpus context",
    urls.length === 0,
    JSON.stringify(urls)
  );
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
