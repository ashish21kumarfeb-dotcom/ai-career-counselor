import { desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { memory } from "../../db/schema";

// Data-access helpers for the `memory` table (Phase 4, memory slice). One row per
// (user_id, memory_key) is guaranteed by the composite unique constraint, so
// writes upsert on that pair instead of accumulating duplicates.

export type MemoryEntry = { memoryKey: string; memoryValue: string };

// Read bounds. Every row returned here is concatenated into the prompt by the
// Profile Agent, so this query decides part of the prompt's size.
//
// WHY BOUND AT ALL, GIVEN THE VOCABULARY. Extraction maps every fact onto five
// fixed keys and clips values to 300 chars (ai/memory.ts), and the unique
// constraint gives one row per (user, key) — so in normal operation a user has at
// most five short rows and these caps never bind. But that bound is enforced by
// the WRITER, and this is the READER. Anything that writes a key outside the
// vocabulary — a legacy row from before it was fixed, a future writer, a direct
// upsertMemory call, which is unvalidated — accumulates a row that no upsert will
// ever replace, and the prompt grows silently and permanently for that user. The
// cost of enforcing it here is nil; the cost of assuming it is a prompt that
// nobody notices growing.
//
// 12 rows x 300 chars ~= 3.6 KB, roughly 900 tokens, as a hard worst case.
export const MAX_MEMORY_ROWS = 12;
export const MAX_MEMORY_VALUE_CHARS = 300;

// Newest first, then capped. The ordering is load-bearing twice over: it decides
// WHICH rows survive the cap (the freshest, since a stale memory is the one worth
// losing), and it makes the result deterministic at all. Without an ORDER BY,
// Postgres may return rows in any order, so the memory section of the prompt —
// and therefore the answer — could vary between two identical requests for
// reasons nothing in this codebase controls.
export async function getMemoryByUserId(
  userId: string,
  limit: number = MAX_MEMORY_ROWS
): Promise<MemoryEntry[]> {
  const rows = await db
    .select({ memoryKey: memory.memoryKey, memoryValue: memory.memoryValue })
    .from(memory)
    .where(eq(memory.userId, userId))
    .orderBy(desc(memory.updatedAt))
    .limit(limit);

  // Clip at the read as well. A row written before the extractor's own limit
  // existed, or by any caller that skipped it, cannot expand the prompt.
  return rows.map((row) =>
    row.memoryValue.length > MAX_MEMORY_VALUE_CHARS
      ? { ...row, memoryValue: `${row.memoryValue.slice(0, MAX_MEMORY_VALUE_CHARS - 1)}…` }
      : row
  );
}

export async function upsertMemory(
  userId: string,
  key: string,
  value: string
): Promise<void> {
  await db
    .insert(memory)
    .values({ userId, memoryKey: key, memoryValue: value })
    .onConflictDoUpdate({
      target: [memory.userId, memory.memoryKey],
      set: { memoryValue: value, updatedAt: new Date() },
    });
}
