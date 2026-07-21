// embeddings:backfill — give every chunk a vector.
//
// The counterpart to chunks:backfill, and it exists for the same reason: a chunk
// missing its vector is not broken, it is HALF-VISIBLE. Lexical search still finds
// it, so nothing errors and nothing looks wrong — the corpus simply answers
// paraphrased questions worse than it should, silently and forever. The report is
// the important half of this script; the writing is the easy half.
//
// Chunks end up unembedded whenever a document was written while VOYAGE_API_KEY was
// unset or the provider was failing, since the write path degrades rather than
// throwing (see src/lib/documents/write.ts). That is the intended behaviour, and
// this is the drain for it.
//
// Idempotent and resumable: without --all it only touches rows where embedding IS
// NULL, so re-running after a partial failure continues where it stopped.
//
// Run: npm run embeddings:backfill           (only chunks missing a vector)
//      npm run embeddings:backfill -- --all  (re-embed everything; use after a
//                                             model or dimension change)
//      npm run embeddings:backfill -- --check (report only, write nothing)
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { documentChunks } from "../src/db/schema";
import { EMBEDDING_MODEL, embeddingsEnabled } from "../src/lib/ai/embeddings";
import { embedChunks, findUnembeddedChunkIds } from "../src/lib/documents/write";

const args = new Set(process.argv.slice(2));
const all = args.has("--all");
const checkOnly = args.has("--check");

async function coverage(): Promise<{ total: number; embedded: number }> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      embedded: sql<number>`count(${documentChunks.embedding})::int`,
    })
    .from(documentChunks);
  return { total: row?.total ?? 0, embedded: row?.embedded ?? 0 };
}

const before = await coverage();
const missing = await findUnembeddedChunkIds();

console.log(`\nModel: ${EMBEDDING_MODEL}`);
console.log(`Chunks: ${before.total}   With a vector: ${before.embedded}`);
console.log(`Chunks with NO vector (invisible to semantic search): ${missing.length}`);

if (checkOnly) {
  if (missing.length > 0) {
    console.log("\nRun `npm run embeddings:backfill` to fix.\n");
    process.exit(1);
  }
  console.log("\nEvery chunk is embedded.\n");
  process.exit(0);
}

// Checked BEFORE any work rather than letting the writes no-op. Without the key
// every embedding comes back null, the script writes nothing, and the report reads
// "0 embedded" — which is indistinguishable from "nothing needed doing".
if (!embeddingsEnabled()) {
  console.error(
    "\nVOYAGE_API_KEY is not set, so no embeddings can be generated.\n" +
      "Retrieval still works lexically; add the key to .env and re-run to enable\n" +
      "the semantic half of hybrid search.\n"
  );
  process.exit(1);
}

if (!all && missing.length === 0) {
  console.log("\nNothing to do — every chunk already has a vector.");
  console.log("(Use --all to re-embed the whole corpus after a model change.)\n");
  process.exit(0);
}

console.log(all ? "\nRe-embedding ALL chunks…" : `\nEmbedding ${missing.length} chunk(s)…`);

const written = await embedChunks(all ? "all" : "missing");

const after = await coverage();
const stillMissing = await findUnembeddedChunkIds();

console.log(`\nWrote ${written} vector(s).`);
console.log(`Chunks: ${after.total}   With a vector: ${after.embedded}`);
console.log(`Chunks still without a vector: ${stillMissing.length}\n`);

// A non-zero remainder after a run that was supposed to fix it means the provider
// rejected or failed those texts. Exiting non-zero so this cannot pass unnoticed
// in a script chain.
process.exit(stillMissing.length === 0 ? 0 : 1);
