import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { documents } from "../../db/schema";
import { createDocument } from "../documents/write";

// Resume documents are stored in the shared `documents` table as user-owned rows
// (type "resume", user_id set). Being user-owned, they are visible only to their
// owner's RAG grounding (see searchDocuments scoping) — never to other users.
// The sourceUrl carries a non-http marker so a resume is never mistaken for a
// citable external resource link (searchResources requires an http source_url).
//
// PII is redacted at the write, rather than at each call site. Scoping keeps a
// resume away from other users; redaction keeps the identifiers out of the row in
// the first place, so no future scoping bug, prompt leak, or provider request can
// expose them. It now lives in createDocument (documents/write.ts) alongside
// chunking, so the chunk copies cannot preserve what the source row stripped —
// the route also redacts before deriving its preview and memory facts, and
// redactPII is idempotent, so the double application is harmless.

const RESUME_SOURCE_PREFIX = "resume-upload/";

export type ResumeRow = {
  id: string;
  content: string;
  sourceUrl: string | null;
  createdAt: Date;
};

// Replace the user's active resume: remove any prior resume rows, then insert the
// new one, so there is exactly one active resume per user.
export async function upsertResume(userId: string, content: string, filename: string) {
  await db
    .delete(documents)
    .where(and(eq(documents.userId, userId), eq(documents.type, "resume")));

  // Via createDocument so the resume is chunked on the way in. Retrieval reads
  // chunks, so a resume inserted directly here would be stored, shown in the UI,
  // and silently absent from the user's own grounding.
  //
  // The delete above removes the prior resume row, and document_chunks cascades
  // from it — the replaced resume's passages cannot outlive it.
  const id = await createDocument({
    userId,
    type: "resume",
    content,
    sourceUrl: `${RESUME_SOURCE_PREFIX}${filename}`,
  });

  const [row] = await db
    .select({ id: documents.id, createdAt: documents.createdAt })
    .from(documents)
    .where(eq(documents.id, id));

  return row;
}

export async function getResumeByUserId(userId: string): Promise<ResumeRow | undefined> {
  const rows = await db
    .select({
      id: documents.id,
      content: documents.content,
      sourceUrl: documents.sourceUrl,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.type, "resume")))
    .orderBy(desc(documents.createdAt))
    .limit(1);
  return rows[0];
}

// The original uploaded filename, recovered from the sourceUrl marker.
export function resumeFilename(row: Pick<ResumeRow, "sourceUrl">): string {
  return (row.sourceUrl ?? "").replace(RESUME_SOURCE_PREFIX, "") || "resume";
}
