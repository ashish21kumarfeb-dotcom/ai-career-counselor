// User-scoping tests for searchDocuments (RAG grounding). A user's own document
// (e.g. an uploaded resume) must be retrievable for THEIR queries but never for
// another user's — and global curated docs stay visible to everyone. Inserts its
// own fixtures (marked with a "test-scoping" token) and cleans up. No LLM.
// Run: npm run test:scoping   (requires DATABASE_URL)
import "dotenv/config";
import { ilike, inArray } from "drizzle-orm";
import { db } from "../src/db/index";
import { users, documents } from "../src/db/schema";
import { searchDocuments } from "../src/lib/documents/queries";

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

async function cleanup() {
  await db.delete(documents).where(ilike(documents.sourceUrl, `%${TOKEN}%`));
  await db.delete(users).where(inArray(users.email, [emailA, emailB]));
}

await cleanup(); // clear leftovers from a prior aborted run
const [ua] = await db.insert(users).values({ name: "Scope A", email: emailA }).returning({ id: users.id });
const [ub] = await db.insert(users).values({ name: "Scope B", email: emailB }).returning({ id: users.id });

try {
  await db.insert(documents).values([
    // user A's private doc (e.g. their resume)
    {
      userId: ua.id,
      type: "resume",
      sourceUrl: `${TOKEN}/resume-a`,
      content: `Resume of user A: experienced ${TOPIC} engineer with cloud skills.`,
    },
    // a global curated doc on the same topic -> visible to everyone
    {
      userId: null,
      type: "career_data",
      sourceUrl: `${TOKEN}/global-topic`,
      content: `Global guidance about ${TOPIC} careers and how to grow in them.`,
    },
  ]);

  console.log("\n== searchDocuments user scoping ==");

  const asA = await searchDocuments(TOPIC, ua.id);
  const urlsA = asA.map((d) => d.sourceUrl);
  check("owner A sees their own resume", urlsA.includes(`${TOKEN}/resume-a`), JSON.stringify(urlsA));
  check("owner A also sees the global doc", urlsA.includes(`${TOKEN}/global-topic`), JSON.stringify(urlsA));

  const asB = await searchDocuments(TOPIC, ub.id);
  const urlsB = asB.map((d) => d.sourceUrl);
  check("user B does NOT see A's resume (cross-user isolation)", !urlsB.includes(`${TOKEN}/resume-a`), JSON.stringify(urlsB));
  check("user B still sees the global doc", urlsB.includes(`${TOKEN}/global-topic`), JSON.stringify(urlsB));

  const anon = await searchDocuments(TOPIC);
  const urlsAnon = anon.map((d) => d.sourceUrl);
  check("no userId -> only global docs (no user resume)", !urlsAnon.includes(`${TOKEN}/resume-a`) && urlsAnon.includes(`${TOKEN}/global-topic`), JSON.stringify(urlsAnon));
} finally {
  await cleanup();
  console.log("\ncleaned up fixtures + throwaway users.");
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
