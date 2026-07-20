// chunks:backfill — segment every existing document into document_chunks.
//
// Retrieval reads chunks, so any document without them is invisible to grounding
// while still looking perfectly healthy in the documents table and the UI. This
// script both CREATES the missing chunks and REPORTS the gap, and the report is
// the more important half: it is the only thing that will ever tell you the
// corpus is partly unreachable.
//
// Idempotent. writeChunks deletes a document's existing chunks before inserting
// fresh ones, so re-running after a chunking-strategy change re-segments the
// whole corpus rather than duplicating it.
//
// Run: npm run chunks:backfill          (only documents missing chunks)
//      npm run chunks:backfill -- --all (re-chunk everything; use after a
//                                        strategy change)
//      npm run chunks:backfill -- --check (report only, write nothing)
import "dotenv/config";
import {
  chunkCoverage,
  findUnchunkedDocumentIds,
  rechunkDocuments,
} from "../src/lib/documents/write";

const args = new Set(process.argv.slice(2));
const all = args.has("--all");
const checkOnly = args.has("--check");

const before = await chunkCoverage();
const missing = await findUnchunkedDocumentIds();

console.log(`\nDocuments: ${before.documents}   Chunks: ${before.chunks}`);
console.log(`Documents with NO chunks (invisible to retrieval): ${missing.length}`);

if (checkOnly) {
  if (missing.length > 0) {
    console.log("\nRun `npm run chunks:backfill` to fix.\n");
    process.exit(1);
  }
  console.log("\nEvery document is chunked.\n");
  process.exit(0);
}

const targets = all ? undefined : missing;

if (!all && missing.length === 0) {
  console.log("\nNothing to do — every document already has chunks.");
  console.log("(Use --all to re-chunk the whole corpus after a strategy change.)\n");
  process.exit(0);
}

console.log(all ? "\nRe-chunking ALL documents…" : `\nChunking ${missing.length} document(s)…`);

const results = await rechunkDocuments(targets);
const totalChunks = results.reduce((n, r) => n + r.chunks, 0);

// A document that produced zero chunks is a real anomaly — chunkDocument only
// returns [] for content that is entirely whitespace — so name them rather than
// letting them average into the totals.
const empty = results.filter((r) => r.chunks === 0);

console.log(`\nProcessed ${results.length} document(s) -> ${totalChunks} chunk(s).`);
if (results.length > 0) {
  console.log(`Average ${(totalChunks / results.length).toFixed(1)} chunks per document.`);
}
if (empty.length > 0) {
  console.log(`\nWARNING: ${empty.length} document(s) produced NO chunks (empty content):`);
  for (const e of empty) console.log(`  ${e.id}`);
}

const after = await chunkCoverage();
const stillMissing = await findUnchunkedDocumentIds();
console.log(`\nDocuments: ${after.documents}   Chunks: ${after.chunks}`);
console.log(`Documents still without chunks: ${stillMissing.length}\n`);

process.exit(stillMissing.length === 0 ? 0 : 1);
