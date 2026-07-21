// User-scoping tests for searchDocuments (RAG grounding). A user's own document
// (e.g. an uploaded resume) must be retrievable for THEIR queries but never for
// another user's — and global curated docs stay visible to everyone. Inserts its
// own fixtures (marked with a "test-scoping" token) and cleans up. No LLM.
//
// EXTENDED FOR CHUNK-LEVEL RETRIEVAL. Scoping is the property most at risk when
// retrieval moves from documents to passages: ownership lives on the document
// row, matching happens on a chunk row, and the two are now joined by the query
// rather than being the same row. A join written with the filter on the wrong
// side leaks one user's resume passages to another user while every
// document-level test still passes. So the fixtures below deliberately include a
// MULTI-CHUNK private resume — the shape that only breaks once a document has
// more than one passage.
// Run: npm run test:scoping   (requires DATABASE_URL)
import "dotenv/config";
import { eq, ilike, inArray } from "drizzle-orm";
import { db } from "../src/db/index";
import { users, documents, documentChunks } from "../src/db/schema";
import { searchDocuments } from "../src/lib/documents/queries";
import { createDocument } from "../src/lib/documents/write";

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

const TOKEN = "test-scoping"; // present in every fixture source_url for cleanup
const emailA = "scopingtest+a@example.test";
const emailB = "scopingtest+b@example.test";
// Distinctive topic term unlikely to collide with seeded content.
const TOPIC = "zylophonics";
// A second distinctive term used only inside a LATER chunk of a long document, so
// a test can prove retrieval reaches beyond the first passage.
const DEEP_TOPIC = "quazzlebrite";

async function cleanup() {
  await db.delete(documents).where(ilike(documents.sourceUrl, `%${TOKEN}%`));
  await db.delete(users).where(inArray(users.email, [emailA, emailB]));
}

await cleanup(); // clear leftovers from a prior aborted run
const [ua] = await db.insert(users).values({ name: "Scope A", email: emailA }).returning({ id: users.id });
const [ub] = await db.insert(users).values({ name: "Scope B", email: emailB }).returning({ id: users.id });

// Filler long enough to force several chunks, with no topic terms of its own.
const filler = (word: string, n = 130) => Array.from({ length: n }, () => word).join(" ");

try {
  // user A's private doc (e.g. their resume) — SHORT, single chunk
  await createDocument({
    userId: ua.id,
    type: "resume",
    sourceUrl: `${TOKEN}/resume-a`,
    content: `Resume of user A: experienced ${TOPIC} engineer with cloud skills.`,
  });

  // a global curated doc on the same topic -> visible to everyone
  await createDocument({
    userId: null,
    type: "career_data",
    sourceUrl: `${TOKEN}/global-topic`,
    content: `Global guidance about ${TOPIC} careers and how to grow in them.`,
  });

  // user A's LONG private doc: the topic term appears only in a late passage, so
  // matching it proves retrieval searched past the first chunk — and any leak of
  // it to user B proves the join dropped the ownership filter.
  await createDocument({
    userId: ua.id,
    type: "resume",
    sourceUrl: `${TOKEN}/resume-a-long`,
    content: [
      filler("padding"),
      filler("irrelevant"),
      `Deep in the document: user A also has ${DEEP_TOPIC} ${TOPIC} certification and experience.`,
      filler("trailing"),
    ].join("\n\n"),
  });

  // a global doc that mentions the topic MANY times across MANY chunks. Without
  // per-document dedup this one document can occupy every result slot.
  await createDocument({
    userId: null,
    type: "industry_article",
    sourceUrl: `${TOKEN}/global-repetitive`,
    content: Array.from(
      { length: 6 },
      (_, i) => `Section ${i}: an extended discussion of ${TOPIC} practice. ${filler("elaboration", 60)}`
    ).join("\n\n"),
  });

  console.log("\n== searchDocuments user scoping ==");

  const asA = await searchDocuments(TOPIC, ua.id, 10);
  const urlsA = asA.map((d) => d.sourceUrl);
  check("owner A sees their own resume", urlsA.includes(`${TOKEN}/resume-a`), JSON.stringify(urlsA));
  check("owner A also sees the global doc", urlsA.includes(`${TOKEN}/global-topic`), JSON.stringify(urlsA));

  const asB = await searchDocuments(TOPIC, ub.id, 10);
  const urlsB = asB.map((d) => d.sourceUrl);
  check("user B does NOT see A's resume (cross-user isolation)", !urlsB.includes(`${TOKEN}/resume-a`), JSON.stringify(urlsB));
  check("user B still sees the global doc", urlsB.includes(`${TOKEN}/global-topic`), JSON.stringify(urlsB));

  const anon = await searchDocuments(TOPIC, undefined, 10);
  const urlsAnon = anon.map((d) => d.sourceUrl);
  check("no userId -> only global docs (no user resume)", !urlsAnon.includes(`${TOKEN}/resume-a`) && urlsAnon.includes(`${TOKEN}/global-topic`), JSON.stringify(urlsAnon));

  console.log("\n== scoping holds at CHUNK granularity ==");
  {
    // The multi-chunk private document is the real test: its matching passage is
    // a separate row from the one carrying the owner id.
    check(
      "owner A retrieves their long private doc",
      urlsA.includes(`${TOKEN}/resume-a-long`),
      JSON.stringify(urlsA)
    );
    check(
      "user B does NOT see any passage of A's long private doc",
      !urlsB.includes(`${TOKEN}/resume-a-long`),
      JSON.stringify(urlsB)
    );
    check(
      "anonymous does NOT see any passage of A's long private doc",
      !urlsAnon.includes(`${TOKEN}/resume-a-long`),
      JSON.stringify(urlsAnon)
    );

    // A term that exists ONLY in user A's private document must retrieve nothing
    // at all for user B — not merely a different ranking.
    const deepB = await searchDocuments(`${DEEP_TOPIC} certification`, ub.id, 10);
    check(
      "a term unique to A's private doc returns nothing for B",
      deepB.every((d) => d.sourceUrl !== `${TOKEN}/resume-a-long`),
      JSON.stringify(deepB.map((d) => d.sourceUrl))
    );
  }

  console.log("\n== retrieval returns PASSAGES, not whole documents ==");
  {
    const long = await searchDocuments(`${DEEP_TOPIC} ${TOPIC}`, ua.id, 10);
    const hit = long.find((d) => d.sourceUrl === `${TOKEN}/resume-a-long`);
    check("the long private doc is retrieved for its deep term", hit !== undefined, JSON.stringify(long.map((d) => d.sourceUrl)));
    if (hit) {
      const [full] = await db
        .select({ content: documents.content })
        .from(documents)
        .where(eq(documents.sourceUrl, `${TOKEN}/resume-a-long`));
      check(
        "returned content is shorter than the whole document",
        hit.content.length < full.content.length,
        `${hit.content.length} vs ${full.content.length}`
      );
      check(
        "returned passage contains the matching term",
        hit.content.includes(DEEP_TOPIC),
        hit.content.slice(0, 120)
      );
      check(
        "returned passage is not padded with the whole document's filler",
        !hit.content.includes(filler("padding")),
        hit.content.slice(0, 120)
      );
    }
  }

  console.log("\n== one document cannot occupy every result slot ==");
  {
    const results = await searchDocuments(TOPIC, ua.id, 5);
    const urls = results.map((d) => d.sourceUrl);
    const repetitive = urls.filter((u) => u === `${TOKEN}/global-repetitive`).length;
    check(
      "the repetitive multi-chunk document appears at most once",
      repetitive <= 1,
      JSON.stringify(urls)
    );
    check(
      "results are distinct documents",
      new Set(urls).size === urls.length,
      JSON.stringify(urls)
    );
    check(
      "other documents still make the cut alongside it",
      new Set(urls).size >= 2,
      JSON.stringify(urls)
    );
  }

  console.log("\n== the identity contract is preserved ==");
  {
    const results = await searchDocuments(TOPIC, ua.id, 10);
    const hit = results.find((d) => d.sourceUrl === `${TOKEN}/global-topic`);
    check("result carries a document id, not a chunk id", hit !== undefined && (await isDocumentId(hit.id)), JSON.stringify(hit));
    check("result carries the document's type", hit?.type === "career_data", String(hit?.type));
    check("result carries the document's sourceUrl", hit?.sourceUrl === `${TOKEN}/global-topic`);
  }

  console.log("\n== the abstention floor survives chunking ==");
  {
    // Nothing in the corpus is about this. Chunking multiplies the number of
    // candidate rows, which is exactly the pressure that makes a near-miss look
    // like a match — the floor must still return nothing.
    const nothing = await searchDocuments("underwater basketweaving certification", ua.id, 5);
    check("an off-corpus query still returns []", nothing.length === 0, JSON.stringify(nothing.map((d) => d.sourceUrl)));
  }
} finally {
  await cleanup();
  console.log("\ncleaned up fixtures + throwaway users.");
}

// True if the id belongs to `documents` (rather than `document_chunks`).
async function isDocumentId(id: string): Promise<boolean> {
  const rows = await db.select({ id: documents.id }).from(documents).where(eq(documents.id, id));
  if (rows.length > 0) return true;
  const chunkRows = await db
    .select({ id: documentChunks.id })
    .from(documentChunks)
    .where(eq(documentChunks.id, id));
  console.log(`    (id ${id} matched ${chunkRows.length} chunk rows and 0 document rows)`);
  return false;
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
