// Bounds on the memory READ path.
//
// LIVE — the properties under test are ordering and LIMIT, which are behaviours
// of the query, not of any code a stub would exercise. Creates a throwaway user,
// writes rows directly (deliberately bypassing the extractor, since the point is
// what happens when the writer's invariants are NOT the reader's), and deletes
// both afterwards.
// Run: npm run test:membounds     (needs DATABASE_URL)
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { memory, users } from "../src/db/schema";
import {
  getMemoryByUserId,
  upsertMemory,
  MAX_MEMORY_ROWS,
  MAX_MEMORY_VALUE_CHARS,
} from "../src/lib/memory/queries";

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

const suffix = Math.floor(Math.random() * 1e9);
const [testUser] = await db
  .insert(users)
  .values({
    name: "membounds test",
    email: `membounds-${suffix}@test.invalid`,
    passwordHash: "not-a-real-hash",
  })
  .returning({ id: users.id });

const userId = testUser.id;

try {
  console.log("\n== normal operation is untouched ==");
  {
    await upsertMemory(userId, "target_role_or_company", "Wants to become a data analyst.");
    await upsertMemory(userId, "timeline", "Aiming to switch within 4 months.");
    const rows = await getMemoryByUserId(userId);
    check("both rows returned", rows.length === 2, String(rows.length));
    check(
      "values intact",
      rows.some((r) => r.memoryValue === "Aiming to switch within 4 months."),
      JSON.stringify(rows)
    );
  }

  console.log("\n== upsert still replaces in place ==");
  {
    await upsertMemory(userId, "timeline", "Now aiming for 6 months.");
    const rows = await getMemoryByUserId(userId);
    check("still two rows, not three", rows.length === 2, String(rows.length));
    check(
      "the newer value won",
      rows.some((r) => r.memoryValue === "Now aiming for 6 months."),
      JSON.stringify(rows)
    );
  }

  console.log("\n== key drift cannot grow the prompt without limit ==");
  {
    // The failure this guards: a writer that ignores the fixed vocabulary. Each
    // novel key is a row no upsert will ever replace.
    for (let i = 0; i < MAX_MEMORY_ROWS + 8; i++) {
      await upsertMemory(userId, `drifted_key_${i}`, `stray fact ${i}`);
    }
    const rows = await getMemoryByUserId(userId);
    check(`capped at ${MAX_MEMORY_ROWS} rows`, rows.length === MAX_MEMORY_ROWS, String(rows.length));

    // Freshest survive: the last keys written must be present, the first dropped.
    const keys = new Set(rows.map((r) => r.memoryKey));
    const newest = `drifted_key_${MAX_MEMORY_ROWS + 7}`;
    check("the newest row survived the cap", keys.has(newest), [...keys].join(","));
    check("the oldest row was dropped", !keys.has("target_role_or_company"), [...keys].join(","));
  }

  console.log("\n== an oversized value is clipped at the read ==");
  {
    await db.delete(memory).where(eq(memory.userId, userId));
    const huge = "x".repeat(5000);
    await upsertMemory(userId, "constraints", huge);
    const rows = await getMemoryByUserId(userId);
    check("one row", rows.length === 1, String(rows.length));
    check(
      "clipped to the cap",
      rows[0].memoryValue.length === MAX_MEMORY_VALUE_CHARS,
      String(rows[0].memoryValue.length)
    );
    check("clipping is marked with an ellipsis", rows[0].memoryValue.endsWith("…"));
  }

  console.log("\n== worst case is bounded and small ==");
  {
    await db.delete(memory).where(eq(memory.userId, userId));
    for (let i = 0; i < 40; i++) {
      await upsertMemory(userId, `k${i}`, "y".repeat(2000));
    }
    const rows = await getMemoryByUserId(userId);
    const chars = rows.reduce((n, r) => n + r.memoryKey.length + r.memoryValue.length, 0);
    check("row count bounded", rows.length === MAX_MEMORY_ROWS, String(rows.length));
    check(
      "total memory text stays under 4 KB even in the worst case",
      chars < 4096,
      `${chars} chars`
    );
  }

  console.log("\n== an unknown user reads cleanly ==");
  {
    const rows = await getMemoryByUserId("00000000-0000-0000-0000-000000000000");
    check("no rows, no throw", rows.length === 0);
  }
} finally {
  await db.delete(memory).where(eq(memory.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  console.log("\n(cleaned up test user and memory)");
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"} — passed: ${passed}, failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
