import { eq } from "drizzle-orm";
import { db } from "../../db";
import { memory } from "../../db/schema";

// Data-access helpers for the `memory` table (Phase 4, memory slice). One row per
// (user_id, memory_key) is guaranteed by the composite unique constraint, so
// writes upsert on that pair instead of accumulating duplicates.

export type MemoryEntry = { memoryKey: string; memoryValue: string };

export async function getMemoryByUserId(userId: string): Promise<MemoryEntry[]> {
  return db
    .select({ memoryKey: memory.memoryKey, memoryValue: memory.memoryValue })
    .from(memory)
    .where(eq(memory.userId, userId));
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
