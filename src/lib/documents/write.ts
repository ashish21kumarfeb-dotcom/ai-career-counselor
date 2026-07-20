import { eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { documents, documentChunks } from "../../db/schema";
import { chunkDocument } from "./chunk";
import { redactPII } from "./redact";

// THE write path for documents.
//
// Its whole reason for existing is one invariant: **a document row always has
// chunk rows**. Retrieval reads chunks, so a document written without them is
// not merely unindexed — it is invisible, silently, with no error anywhere. That
// is the worst failure shape available here, because the system keeps answering,
// just without the evidence it should have had.
//
// The invariant cannot be enforced by the schema (no constraint expresses "at
// least one child row"), and it cannot be enforced by convention, because there
// are six different callers inserting documents today. So it is enforced by
// making this the only sanctioned way in, and by giving the backfill script a
// check that reports any document that lacks chunks.
//
// Redaction is applied here too, for the same reason it is applied in
// upsertResume: whatever reaches this function is about to become durable, and
// the chunk copies must not preserve identifiers the source row had stripped.

export type DocumentType = typeof documents.$inferInsert.type;

export type NewDocument = {
  userId?: string | null;
  type: DocumentType;
  content: string;
  sourceUrl?: string | null;
};

// Insert a document and its chunks. Returns the document row id.
//
// Not transactional: the neon-http driver has no multi-statement transaction, so
// a failure between the two inserts would leave a chunkless document. That is
// why the chunk insert comes second and its failure is loud — a document with no
// chunks is detectable and repairable by re-running the backfill, whereas the
// reverse ordering would leave orphan chunks with no owner.
export async function createDocument(input: NewDocument): Promise<string> {
  const content = redactPII(input.content).text;

  const [row] = await db
    .insert(documents)
    .values({
      userId: input.userId ?? null,
      type: input.type,
      content,
      sourceUrl: input.sourceUrl ?? null,
    })
    .returning({ id: documents.id });

  await writeChunks(row.id, content);
  return row.id;
}

// Replace a document's chunks with a fresh segmentation of `content`.
// Idempotent: running it twice produces the same rows, which is what lets the
// backfill be re-run safely after a chunking-strategy change.
export async function writeChunks(documentId: string, content: string): Promise<number> {
  const chunks = chunkDocument(content);

  await db.delete(documentChunks).where(eq(documentChunks.documentId, documentId));
  if (chunks.length === 0) return 0;

  await db.insert(documentChunks).values(
    chunks.map((text, index) => ({ documentId, chunkIndex: index, content: text }))
  );
  return chunks.length;
}

// Documents that have no chunk rows — i.e. documents retrieval cannot see.
// Used by the backfill script and worth calling after any bulk import.
export async function findUnchunkedDocumentIds(): Promise<string[]> {
  const chunked = db.selectDistinct({ id: documentChunks.documentId }).from(documentChunks);
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(notInArray(documents.id, chunked));
  return rows.map((r) => r.id);
}

// Chunk-coverage counts, for the backfill report.
export async function chunkCoverage(): Promise<{ documents: number; chunks: number }> {
  const [docs] = await db.select({ n: sql<number>`count(*)::int` }).from(documents);
  const [chunks] = await db.select({ n: sql<number>`count(*)::int` }).from(documentChunks);
  return { documents: docs?.n ?? 0, chunks: chunks?.n ?? 0 };
}

// Re-chunk a specific set of documents (or all of them). Returns per-document
// chunk counts so the caller can report what changed.
export async function rechunkDocuments(
  documentIds?: string[]
): Promise<Array<{ id: string; chunks: number }>> {
  const rows = await db
    .select({ id: documents.id, content: documents.content })
    .from(documents)
    .where(documentIds ? inArray(documents.id, documentIds) : undefined);

  const out: Array<{ id: string; chunks: number }> = [];
  for (const row of rows) {
    out.push({ id: row.id, chunks: await writeChunks(row.id, row.content) });
  }
  return out;
}
