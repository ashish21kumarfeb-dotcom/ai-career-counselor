// One-off DATA backfill: move legacy `details.yearsOfExperience` into the
// dedicated `user_profiles.years_experience` integer column.
//
// Context: "Years of experience" was originally collected into the `details`
// jsonb bag as free text. It later moved to a dedicated integer column
// (migration 0010), but rows created before that kept their value in `details`
// and got a NULL column — so the value stopped showing (detailEntries also skips
// the legacy key). This backfill parses the stored text to a whole number
// (leading digits, e.g. "3+" -> 3, "5 years" -> 5; non-numeric -> NULL), writes
// the column, and removes the now-redundant `yearsOfExperience` key from details.
//
// Data migration, not schema — NOT part of the drizzle-kit chain. Idempotent:
// re-running finds 0 rows with the legacy key and is a no-op. Only touches rows
// that still carry `details.yearsOfExperience` and whose column is NULL.
//
// Provenance: first run on 2026-07-14 — 1 row (user 3917b85a…, "3+" -> 3).
//
// Run standalone:  npx tsx src/db/backfill/years-experience-from-details.ts
//            or:   npm run backfill:years-experience
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

async function backfill() {
  const before = await sql`
    SELECT user_id, years_experience, details->>'yearsOfExperience' AS legacy
    FROM user_profiles
    WHERE details ? 'yearsOfExperience' AND years_experience IS NULL`;
  console.log(`rows to backfill: ${(before as unknown[]).length}`);
  for (const r of before as { user_id: string; legacy: string }[]) {
    console.log(`  user ${r.user_id} | details.yearsOfExperience="${r.legacy}"`);
  }
  if ((before as unknown[]).length === 0) {
    console.log("Nothing to backfill (already done or none present).");
    return;
  }

  // Parse leading digits -> integer column; drop the key (details -> NULL if it
  // becomes empty). Rows whose text has no leading digit get a NULL column but
  // still have the junk key removed.
  const updated = await sql`
    UPDATE user_profiles
    SET years_experience = NULLIF(substring(details->>'yearsOfExperience' from '^[0-9]+'), '')::int,
        details = NULLIF(details - 'yearsOfExperience', '{}'::jsonb),
        updated_at = now()
    WHERE details ? 'yearsOfExperience' AND years_experience IS NULL
    RETURNING user_id, years_experience`;
  console.log(`rows updated: ${(updated as unknown[]).length}`);
  for (const r of updated as { user_id: string; years_experience: number | null }[]) {
    console.log(`  user ${r.user_id} -> years_experience=${r.years_experience}`);
  }

  const remaining = await sql`
    SELECT count(*)::int AS n FROM user_profiles WHERE details ? 'yearsOfExperience'`;
  const n = (remaining as { n: number }[])[0].n;
  console.log(`rows still carrying details.yearsOfExperience: ${n}`);
  if (n !== 0) throw new Error(`Expected 0 remaining, found ${n}`);
}

backfill()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("years-experience backfill failed:", error);
    process.exit(1);
  });
