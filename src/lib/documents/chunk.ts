// Chunking: splitting a document into retrievable passages.
//
// WHY. Retrieval currently returns whole documents, and the whole document is
// what gets pasted into the prompt. That is survivable only because today's
// corpus is tiny (18 rows, longest 548 chars). It stops being survivable the
// moment either side grows: a real uploaded resume is several thousand
// characters, and a scraped industry article more still. At that point whole-
// document retrieval has two failure modes at once — the prompt carries pages of
// mostly-irrelevant text to reach one relevant paragraph, and scoring cannot
// tell a document that is ABOUT the query from one that merely MENTIONS it
// somewhere, because both match identically.
//
// A note on honesty about the present: on today's corpus this changes almost
// nothing. Every current document is shorter than one chunk, so each yields
// exactly one chunk whose content equals the document's. The work is worth doing
// now because the retrieval layer built on top of it (Phase 4) has to be written
// against chunk granularity either way, and backfilling a chunk table is far
// cheaper on 18 rows than on a real corpus.
//
// STRATEGY: structure-aware, largest unit first. Split on paragraph boundaries;
// if a paragraph alone exceeds the target, split it into sentences; if a single
// sentence still exceeds it (a table dumped out of a PDF, a wall of text with no
// punctuation), hard-split on width. Each fallback is strictly rarer than the
// last, so ordinary prose is cut where a human would cut it, and pathological
// input still terminates.

// Target passage size. Chosen to sit comfortably below the ~900-token answer
// budget when three of them are injected together, while staying large enough to
// hold a complete idea — a chunk that ends mid-argument retrieves as well as one
// that does not but grounds an answer worse.
export const TARGET_CHUNK_CHARS = 700;

// A chunk is only emitted early if it has at least this much in it. Prevents a
// short trailing paragraph from becoming a 40-character chunk that matches a
// query term and then grounds nothing.
export const MIN_CHUNK_CHARS = 200;

// Overlap carried from the end of one chunk into the start of the next.
//
// THE POINT OF OVERLAP: a fact stated across a boundary ("...requires SQL." /
// "It also requires Python.") is otherwise in neither chunk as a complete
// statement, and the query that asks about the combination matches neither well.
// Overlap costs storage, which is cheap, and buys recall at the seams.
export const OVERLAP_CHARS = 120;

// Hard ceiling. Nothing may exceed this, including a hard-split fragment, so a
// single chunk can never blow the prompt budget on its own.
export const MAX_CHUNK_CHARS = 1200;

function normalizeWhitespace(text: string): string {
  // Collapse runs of blank lines to a single paragraph break and strip trailing
  // spaces, so paragraph detection is not defeated by formatting noise from a
  // PDF extractor.
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Sentence boundaries: a terminator followed by whitespace. Deliberately naive —
// it will split "Ph.D. programs" — because the cost of that error is a chunk
// boundary in a slightly odd place, while the cost of a clever abbreviation-aware
// splitter is code that has to be maintained for no measurable retrieval gain.
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

// Last resort: split a single oversized unit on width, preferring a word
// boundary near the cut so a hard split does not sever a term in half.
function hardSplit(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_CHUNK_CHARS) {
    const window = rest.slice(0, MAX_CHUNK_CHARS);
    const lastSpace = window.lastIndexOf(" ");
    const cut = lastSpace > MAX_CHUNK_CHARS * 0.6 ? lastSpace : MAX_CHUNK_CHARS;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

// Break the document into the smallest units the packer is allowed to move
// around: paragraphs, subdivided into sentences only when too large, and
// hard-split only when a sentence is itself too large.
function atomicUnits(text: string): string[] {
  const units: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const p = paragraph.trim();
    if (!p) continue;
    if (p.length <= TARGET_CHUNK_CHARS) {
      units.push(p);
      continue;
    }
    for (const sentence of splitSentences(p)) {
      const s = sentence.trim();
      if (!s) continue;
      if (s.length <= MAX_CHUNK_CHARS) units.push(s);
      else units.push(...hardSplit(s));
    }
  }
  return units;
}

// The trailing slice of a chunk to repeat at the head of the next one, cut at a
// word boundary so the overlap reads as text rather than as a fragment.
function overlapTail(chunk: string): string {
  if (OVERLAP_CHARS <= 0 || chunk.length <= OVERLAP_CHARS) return "";
  const tail = chunk.slice(-OVERLAP_CHARS);
  const firstSpace = tail.indexOf(" ");
  return (firstSpace === -1 ? tail : tail.slice(firstSpace + 1)).trim();
}

// Split a document's text into ordered passages.
//
// GUARANTEES, all asserted in tests:
//   - Never returns []. A document with any non-whitespace content yields at
//     least one chunk, so nothing can become silently unretrievable.
//   - No chunk exceeds MAX_CHUNK_CHARS.
//   - A document at or under the target is returned as ONE chunk whose content is
//     the (whitespace-normalized) document. This is what makes the change a
//     no-op for the current corpus.
export function chunkDocument(content: string): string[] {
  const text = normalizeWhitespace(content);
  if (text.length === 0) return [];
  if (text.length <= TARGET_CHUNK_CHARS) return [text];

  const units = atomicUnits(text);
  const chunks: string[] = [];
  let current = "";

  for (const unit of units) {
    if (current.length === 0) {
      current = unit;
      continue;
    }
    const joined = `${current}\n\n${unit}`;
    if (joined.length <= TARGET_CHUNK_CHARS || current.length < MIN_CHUNK_CHARS) {
      // Keep packing: either it still fits, or the current chunk is too small to
      // be worth emitting and is allowed to overshoot the target to reach a
      // usable size. The MAX ceiling below still applies.
      if (joined.length <= MAX_CHUNK_CHARS) {
        current = joined;
        continue;
      }
    }
    chunks.push(current);
    const tail = overlapTail(current);
    current = tail ? `${tail}\n\n${unit}` : unit;
  }

  if (current.trim().length > 0) chunks.push(current);

  // The overlap prefix can push a chunk past the ceiling; enforce it last so the
  // guarantee holds unconditionally.
  return chunks.flatMap((c) => (c.length > MAX_CHUNK_CHARS ? hardSplit(c) : [c]));
}
