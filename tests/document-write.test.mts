// Document write-path tests: the "every document has chunks" invariant, and the
// cascade that stops a replaced resume's passages outliving it.
//
// LIVE — the properties under test are a foreign-key cascade and a uniqueness
// constraint, which are database behaviours. A stub would assert that my mental
// model of Postgres is self-consistent, not that the schema is right.
// Run: npm run test:docwrite     (needs DATABASE_URL)
import "dotenv/config";
import { eq, ilike, inArray } from "drizzle-orm";
import { db } from "../src/db";
import { users, documents, documentChunks } from "../src/db/schema";
import { createDocument, writeChunks, findUnchunkedDocumentIds } from "../src/lib/documents/write";
import { upsertResume, getResumeByUserId } from "../src/lib/resume/queries";
import { TARGET_CHUNK_CHARS } from "../src/lib/documents/chunk";

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

const TOKEN = "test-docwrite";
const email = `docwrite-${Math.floor(Math.random() * 1e9)}@test.invalid`;

async function cleanup(userId?: string) {
  await db.delete(documents).where(ilike(documents.sourceUrl, `%${TOKEN}%`));
  if (userId) await db.delete(documents).where(eq(documents.userId, userId));
  await db.delete(users).where(inArray(users.email, [email]));
}

await cleanup();
const [user] = await db
  .insert(users)
  .values({ name: "Docwrite", email, passwordHash: "x" })
  .returning({ id: users.id });

async function chunksOf(documentId: string) {
  return db
    .select({ index: documentChunks.chunkIndex, content: documentChunks.content })
    .from(documentChunks)
    .where(eq(documentChunks.documentId, documentId))
    .orderBy(documentChunks.chunkIndex);
}

try {
  console.log("\n== createDocument always writes chunks ==");
  {
    const id = await createDocument({
      type: "career_data",
      sourceUrl: `${TOKEN}/short`,
      content: "A short curated note about SQL for analytics roles.",
    });
    const chunks = await chunksOf(id);
    check("one chunk for a short document", chunks.length === 1, String(chunks.length));
    check("chunk content matches the document", chunks[0].content.includes("SQL for analytics"), chunks[0].content);
    check("chunk index starts at 0", chunks[0].index === 0);
  }

  console.log("\n== a long document yields ordered passages ==");
  {
    const long = ["alpha ".repeat(150), "beta ".repeat(150), "gamma ".repeat(150)].join("\n\n");
    const id = await createDocument({
      type: "industry_article",
      sourceUrl: `${TOKEN}/long`,
      content: long,
    });
    const chunks = await chunksOf(id);
    check("multiple chunks", chunks.length > 1, String(chunks.length));
    check(
      "indexes are contiguous from 0",
      chunks.every((c, i) => c.index === i),
      JSON.stringify(chunks.map((c) => c.index))
    );
    check("each chunk is a passage, not the whole doc", chunks.every((c) => c.content.length < long.length));
  }

  console.log("\n== PII is redacted before chunking ==");
  {
    const id = await createDocument({
      type: "resume",
      userId: user.id,
      sourceUrl: `${TOKEN}/pii`,
      content: "Contact me at secret.person@example.com or +91 98765 43210 for SQL work.",
    });
    const chunks = await chunksOf(id);
    const all = chunks.map((c) => c.content).join(" ");
    check("email absent from chunks", !all.includes("secret.person@example.com"), all);
    check("phone absent from chunks", !all.includes("98765 43210"), all);
    check("the useful text survives", all.includes("SQL work"), all);
  }

  console.log("\n== re-chunking is idempotent ==");
  {
    const id = await createDocument({
      type: "career_data",
      sourceUrl: `${TOKEN}/idem`,
      content: "Idempotency check content about data engineering pathways.",
    });
    const first = await chunksOf(id);
    await writeChunks(id, "Idempotency check content about data engineering pathways.");
    await writeChunks(id, "Idempotency check content about data engineering pathways.");
    const after = await chunksOf(id);
    check("count unchanged after re-running twice", after.length === first.length, `${first.length} -> ${after.length}`);
    check("content unchanged", after[0].content === first[0].content);
  }

  console.log("\n== deleting a document cascades to its chunks ==");
  {
    const id = await createDocument({
      type: "career_data",
      sourceUrl: `${TOKEN}/cascade`,
      content: "This document is about to be deleted.",
    });
    check("chunks exist before delete", (await chunksOf(id)).length === 1);
    await db.delete(documents).where(eq(documents.id, id));
    check("chunks are gone after delete", (await chunksOf(id)).length === 0);
  }

  console.log("\n== replacing a resume does not leave the old one retrievable ==");
  {
    // The privacy-relevant case: upsertResume deletes the prior row, and the old
    // passages must not survive to ground a later answer.
    await upsertResume(user.id, `Old resume: expert in ${"COBOL "} maintenance. ${"filler ".repeat(20)}`, "old.pdf");
    const oldRow = await getResumeByUserId(user.id);
    const oldChunks = await chunksOf(oldRow!.id);
    check("old resume chunked", oldChunks.length >= 1, String(oldChunks.length));

    await upsertResume(user.id, `New resume: expert in Rust systems work. ${"filler ".repeat(20)}`, "new.pdf");
    const newRow = await getResumeByUserId(user.id);

    check("a new document row replaced the old", newRow!.id !== oldRow!.id);
    check("old resume's chunks were cascaded away", (await chunksOf(oldRow!.id)).length === 0);

    const newChunks = await chunksOf(newRow!.id);
    const newText = newChunks.map((c) => c.content).join(" ");
    check("new resume is chunked", newChunks.length >= 1);
    check("new content present", newText.includes("Rust"), newText);
    check("old content absent everywhere", !newText.includes("COBOL"), newText);
  }

  console.log("\n== unchunked documents are detectable ==");
  {
    // A document inserted the old way — straight into the table, bypassing
    // createDocument — is exactly what the backfill check exists to catch.
    const [row] = await db
      .insert(documents)
      .values({ type: "career_data", sourceUrl: `${TOKEN}/raw`, content: "Inserted without chunks." })
      .returning({ id: documents.id });

    const missing = await findUnchunkedDocumentIds();
    check("the raw insert is reported as unchunked", missing.includes(row.id), JSON.stringify(missing));

    await writeChunks(row.id, "Inserted without chunks.");
    const after = await findUnchunkedDocumentIds();
    check("after backfill it is no longer reported", !after.includes(row.id));
  }

  console.log("\n== the corpus is fully chunked ==");
  {
    const missing = await findUnchunkedDocumentIds();
    check("no document anywhere lacks chunks", missing.length === 0, `${missing.length} missing`);
  }

  void TARGET_CHUNK_CHARS;
} finally {
  await cleanup(user.id);
  console.log("\ncleaned up fixtures + throwaway user.");
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
