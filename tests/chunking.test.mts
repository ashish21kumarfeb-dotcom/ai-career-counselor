// Chunking-strategy tests. PURE — no DB, no LLM.
//
// The guarantees asserted here are the ones the rest of the retrieval stack
// depends on: nothing with content becomes unretrievable, no chunk can blow the
// prompt budget, and today's short documents pass through unchanged.
// Run: npm run test:chunk
import "dotenv/config";
import {
  chunkDocument,
  TARGET_CHUNK_CHARS,
  MAX_CHUNK_CHARS,
  OVERLAP_CHARS,
} from "../src/lib/documents/chunk";

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

const para = (n: number, word: string) => Array.from({ length: n }, () => word).join(" ");

console.log("\n== short documents pass through unchanged ==");
{
  // The entire current corpus is in this regime (longest document: 548 chars), so
  // this is what makes chunking a no-op for existing behaviour.
  const doc = "Moving into data analytics starts with SQL and spreadsheets.";
  const chunks = chunkDocument(doc);
  check("one chunk", chunks.length === 1, String(chunks.length));
  check("content identical", chunks[0] === doc, chunks[0]);

  const atLimit = para(Math.floor(TARGET_CHUNK_CHARS / 5), "words");
  check("a document at the target size is still one chunk", chunkDocument(atLimit).length === 1);
}

console.log("\n== nothing with content becomes unretrievable ==");
{
  check("empty string -> no chunks", chunkDocument("").length === 0);
  check("whitespace only -> no chunks", chunkDocument("   \n\n  \t ").length === 0);
  check("a single word -> one chunk", chunkDocument("SQL").length === 1);
  check("content is never dropped", chunkDocument("a").join("") === "a");
}

console.log("\n== long documents are split ==");
{
  const long = [
    para(60, "alpha"),
    para(60, "beta"),
    para(60, "gamma"),
    para(60, "delta"),
  ].join("\n\n");
  const chunks = chunkDocument(long);
  check("splits into multiple chunks", chunks.length > 1, String(chunks.length));
  check("every chunk within the hard ceiling", chunks.every((c) => c.length <= MAX_CHUNK_CHARS), JSON.stringify(chunks.map((c) => c.length)));
  check(
    "no chunk is trivially small",
    chunks.slice(0, -1).every((c) => c.length > 100),
    JSON.stringify(chunks.map((c) => c.length))
  );
  // Every distinct source word must survive somewhere.
  const joined = chunks.join(" ");
  check("all source paragraphs represented", ["alpha", "beta", "gamma", "delta"].every((w) => joined.includes(w)));
}

console.log("\n== boundaries follow structure ==");
{
  const doc = `${para(80, "first")}\n\n${para(80, "second")}`;
  const chunks = chunkDocument(doc);
  check("splits at the paragraph boundary", chunks.length === 2, String(chunks.length));
  // With overlap, chunk 2 begins with the tail of chunk 1 — but the bulk of each
  // chunk must still be its own paragraph.
  const secondChunkFirsts = (chunks[1].match(/first/g) ?? []).length;
  const secondChunkSeconds = (chunks[1].match(/second/g) ?? []).length;
  check("the second chunk is mostly the second paragraph", secondChunkSeconds > secondChunkFirsts, `${secondChunkSeconds} vs ${secondChunkFirsts}`);
}

console.log("\n== overlap exists at the seams ==");
{
  const doc = `${para(90, "alpha")}\n\n${para(90, "omega")}`;
  const chunks = chunkDocument(doc);
  check("more than one chunk", chunks.length > 1);
  if (chunks.length > 1) {
    check(
      "the later chunk repeats some of the earlier one",
      chunks[1].includes("alpha"),
      chunks[1].slice(0, 80)
    );
    check("overlap is bounded", (chunks[1].match(/alpha/g) ?? []).length * 6 <= OVERLAP_CHARS + 20);
  }
}

console.log("\n== pathological input still terminates and is bounded ==");
{
  // No paragraph breaks, no sentence terminators, no spaces — every fallback in
  // the strategy is forced, ending at the hard splitter.
  const wall = "x".repeat(10_000);
  const chunks = chunkDocument(wall);
  check("produces chunks", chunks.length > 1, String(chunks.length));
  check("all within the ceiling", chunks.every((c) => c.length <= MAX_CHUNK_CHARS), JSON.stringify(chunks.map((c) => c.length)));
  // Overlap DUPLICATES content by design, so the total is expected to exceed the
  // source. What must hold is that nothing is lost (>= original) and that the
  // duplication stays bounded rather than compounding chunk over chunk.
  const totalChars = chunks.join("").replace(/\s/g, "").length;
  check("no content lost", totalChars >= 10_000, String(totalChars));
  check("overlap does not compound", totalChars < 10_000 * 1.5, String(totalChars));

  // One enormous sentence: sentence-splitting cannot help, hard split must.
  const oneSentence = `${para(500, "word")}.`;
  const sentenceChunks = chunkDocument(oneSentence);
  check("giant sentence is split", sentenceChunks.length > 1);
  check("giant sentence chunks bounded", sentenceChunks.every((c) => c.length <= MAX_CHUNK_CHARS));
}

console.log("\n== formatting noise does not defeat paragraph detection ==");
{
  const messy = `${para(80, "alpha")}   \n\n\n\n\n   ${para(80, "beta")}`;
  const chunks = chunkDocument(messy);
  check("collapsed blank lines still split", chunks.length === 2, String(chunks.length));
  check("no chunk has leading/trailing whitespace", chunks.every((c) => c === c.trim()));
  check("windows line endings handled", chunkDocument("a\r\n\r\nb").length >= 1);
}

console.log("\n== determinism ==");
{
  const doc = [para(70, "one"), para(70, "two"), para(70, "three")].join("\n\n");
  const a = chunkDocument(doc);
  const b = chunkDocument(doc);
  check("same input -> same chunks", JSON.stringify(a) === JSON.stringify(b));
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
