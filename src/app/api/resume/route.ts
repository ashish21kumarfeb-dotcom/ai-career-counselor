import { NextResponse } from "next/server";
import { getSession } from "../../../lib/auth/session";
import { parseResumeFile, normalizeResumeText } from "../../../lib/resume/parse";
import { upsertResume, getResumeByUserId, resumeFilename } from "../../../lib/resume/queries";
import { extractMemories } from "../../../lib/ai/memory";
import { upsertMemory } from "../../../lib/memory/queries";
import { redactPII } from "../../../lib/documents/redact";
import { consumeRateLimit, userSubject, RESUME_LIMIT } from "../../../lib/rate-limit/queries";
import { withUsageCapture, flushUsage, type UsageRow } from "../../../lib/ai/usage";

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

  // Limited before the multipart body is read: parsing a 5 MB upload and running
  // a PDF through pdfjs is the expensive part, and the point is not to pay it.
  const limit = await consumeRateLimit(userSubject(session.userId), RESUME_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many resume uploads in the last hour. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  // Two ingestion paths share the rest of this handler: a multipart file upload
  // (parsed to text) and a JSON { text } body (the user pasting resume text
  // directly). Both converge on `text` + `filename`, then redact/store/extract
  // identically. Branch on content-type.
  let text: string;
  let filename: string;
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Expected resume text." }, { status: 400 });
    }
    const pasted = typeof body === "object" && body !== null ? (body as { text?: unknown }).text : undefined;
    if (typeof pasted !== "string") {
      return NextResponse.json({ error: "No resume text provided." }, { status: 400 });
    }
    if (pasted.length > MAX_BYTES) {
      return NextResponse.json({ error: "Resume text too large (max 5 MB)." }, { status: 400 });
    }
    text = normalizeResumeText(pasted);
    filename = "Pasted resume";

    if (text.trim().length < 30) {
      return NextResponse.json(
        { error: "That looks too short to be a resume — paste the full text." },
        { status: 400 }
      );
    }
  } else {
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
    try {
      text = await parseResumeFile(file.name, file.type, bytes);
    } catch (error) {
      console.error("Resume parse failed:", error);
      const message = error instanceof Error ? error.message : "Could not read that file.";
      return NextResponse.json({ error: message }, { status: 400 });
    }
    filename = file.name;

    if (text.trim().length < 30) {
      return NextResponse.json(
        { error: "Could not extract readable text — the file may be a scanned or image-only PDF." },
        { status: 400 }
      );
    }
  }

  // Redact once, up front, and use the redacted text for EVERYTHING downstream:
  // the stored document, the memory extraction (which writes durable rows of its
  // own, and whose LLM call would otherwise ship the raw resume to the provider),
  // and the preview echoed back to the client. The raw `text` is not referenced
  // past this line.
  const { text: safeText } = redactPII(text);

  try {
    await upsertResume(session.userId, safeText, filename);
  } catch (error) {
    console.error("Resume store failed:", error);
    return NextResponse.json({ error: "Could not save your resume." }, { status: 500 });
  }

  // Extract durable facts into memory — best-effort, never fails the upload.
  //
  // Wrapped in a usage capture even though there is no graph run here: this is a
  // full-resume prompt, which makes it one of the larger single calls in the
  // system, and leaving it off the ledger would understate what the product
  // costs. Its rows carry a null run_id — see the llm_usage table comment.
  const usageRows: UsageRow[] = [];
  try {
    await withUsageCapture({ userId: session.userId }, usageRows, async () => {
      const facts = await extractMemories(safeText);
      for (const fact of facts) {
        await upsertMemory(session.userId, fact.key, fact.value);
      }
    });
  } catch (error) {
    console.error("Resume memory extraction failed:", error);
  }
  await flushUsage(usageRows);

  return NextResponse.json(
    { ok: true, filename, chars: safeText.length, preview: safeText.slice(0, 400) },
    { status: 200 }
  );
}
