import mammoth from "mammoth";

// Extract plain text from an uploaded resume file (PDF / DOCX / TXT). Parsing
// libraries are imported lazily so a route that never receives a PDF doesn't pay
// to load pdfjs. Output is normalized and length-capped for safe storage/prompting.

const MAX_CHARS = 20_000;

export const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".txt"] as const;

function normalize(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Normalize and length-cap resume text that arrives already as text (pasted by
// the user) rather than extracted from a file, so both ingestion paths share the
// same cleanup and MAX_CHARS ceiling before storage/prompting.
export function normalizeResumeText(text: string): string {
  return normalize(text).slice(0, MAX_CHARS);
}

function kindOf(filename: string, mime: string): "pdf" | "docx" | "txt" | null {
  const name = filename.toLowerCase();
  if (name.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  if (name.endsWith(".docx") || mime.includes("officedocument.wordprocessingml")) return "docx";
  if (name.endsWith(".txt") || mime.startsWith("text/")) return "txt";
  return null;
}

export async function parseResumeFile(
  filename: string,
  mime: string,
  bytes: Uint8Array
): Promise<string> {
  const kind = kindOf(filename, mime);
  if (!kind) {
    throw new Error("Unsupported file type. Please upload a PDF, DOCX, or TXT file.");
  }

  let text = "";
  if (kind === "pdf") {
    // pdf-parse v2: PDFParse class; getText() returns the concatenated document text.
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: bytes });
    try {
      const res = await parser.getText();
      text = res.text ?? "";
    } finally {
      await parser.destroy();
    }
  } else if (kind === "docx") {
    const res = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    text = res.value ?? "";
  } else {
    text = Buffer.from(bytes).toString("utf8");
  }

  return normalize(text).slice(0, MAX_CHARS);
}
