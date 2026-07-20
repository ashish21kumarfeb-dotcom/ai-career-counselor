import { NextResponse } from "next/server";
import { getSession } from "../../../lib/auth/session";
import { parseResumeFile } from "../../../lib/resume/parse";
import { upsertResume, getResumeByUserId, resumeFilename } from "../../../lib/resume/queries";
import { extractMemories } from "../../../lib/ai/memory";
import { upsertMemory } from "../../../lib/memory/queries";
import { redactPII } from "../../../lib/documents/redact";

// Resume upload: accepts a PDF / DOCX / TXT file, extracts its text, stores it as
// the user's resume document (available to THEIR RAG grounding only), and best-
// effort extracts durable facts into memory. Node runtime — the parsers use
// Node Buffers and pdfjs. GET returns the current resume summary for the UI.
export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const resume = await getResumeByUserId(session.userId);
  if (!resume) {
    return NextResponse.json({ resume: null }, { status: 200 });
  }
  return NextResponse.json(
    {
      resume: {
        filename: resumeFilename(resume),
        chars: resume.content.length,
        preview: resume.content.slice(0, 400),
        uploadedAt: resume.createdAt,
      },
    },
    { status: 200 }
  );
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a file upload." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "The file is empty." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (max 5 MB)." }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  try {
    text = await parseResumeFile(file.name, file.type, bytes);
  } catch (error) {
    console.error("Resume parse failed:", error);
    const message = error instanceof Error ? error.message : "Could not read that file.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (text.trim().length < 30) {
    return NextResponse.json(
      { error: "Could not extract readable text — the file may be a scanned or image-only PDF." },
      { status: 400 }
    );
  }

  // Redact once, up front, and use the redacted text for EVERYTHING downstream:
  // the stored document, the memory extraction (which writes durable rows of its
  // own, and whose LLM call would otherwise ship the raw resume to the provider),
  // and the preview echoed back to the client. The raw `text` is not referenced
  // past this line.
  const { text: safeText } = redactPII(text);

  try {
    await upsertResume(session.userId, safeText, file.name);
  } catch (error) {
    console.error("Resume store failed:", error);
    return NextResponse.json({ error: "Could not save your resume." }, { status: 500 });
  }

  // Extract durable facts into memory — best-effort, never fails the upload.
  try {
    const facts = await extractMemories(safeText);
    for (const fact of facts) {
      await upsertMemory(session.userId, fact.key, fact.value);
    }
  } catch (error) {
    console.error("Resume memory extraction failed:", error);
  }

  return NextResponse.json(
    { ok: true, filename: file.name, chars: safeText.length, preview: safeText.slice(0, 400) },
    { status: 200 }
  );
}
