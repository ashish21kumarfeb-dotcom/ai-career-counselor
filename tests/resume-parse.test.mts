// Parser tests for the resume upload slice: extracts plain text from PDF, DOCX,
// and TXT fixtures and asserts the key content survives. No DB, no LLM.
// Run: npm run test:parse
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseResumeFile } from "../src/lib/resume/parse";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

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

// Markers we expect to survive extraction from every fixture.
const MARKERS = ["Azure", "AZ-204", "Jane Doe"];

type FileCase = { file: string; mime: string };
const CASES: FileCase[] = [
  { file: "sample-resume.pdf", mime: "application/pdf" },
  { file: "sample-resume.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  { file: "sample-resume.txt", mime: "text/plain" },
];

console.log("\n== parseResumeFile ==");
for (const c of CASES) {
  const bytes = new Uint8Array(await readFile(join(fixtures, c.file)));
  const text = await parseResumeFile(c.file, c.mime, bytes);
  console.log(`\n[${c.file}] extracted ${text.length} chars`);
  check(`[${c.file}] non-empty extraction`, text.length > 20, `len=${text.length}`);
  for (const m of MARKERS) {
    check(`[${c.file}] contains "${m}"`, text.includes(m), text.slice(0, 120));
  }
}

// Unsupported type is rejected.
try {
  await parseResumeFile("photo.png", "image/png", new Uint8Array([1, 2, 3]));
  check("rejects unsupported file type", false, "did not throw");
} catch {
  check("rejects unsupported file type", true);
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
