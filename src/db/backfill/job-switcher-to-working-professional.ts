// One-off DATA backfill: fold the deprecated `job_switcher` user_type into
// `working_professional`.
//
// Context: onboarding dropped "Job switcher" as a separate type — working
// professionals now cover switching (asked via a grow-vs-switch question). The
// `job_switcher` enum value is kept for safety (Postgres can't easily drop an
// in-use enum value), but no new rows use it. This script migrates any legacy
// rows so they display and are treated consistently as working professionals.
//
// This is a data migration, not a schema change, so it is NOT part of the
// drizzle-kit migration chain (drizzle-kit only diffs schema). It is idempotent:
// re-running finds 0 `job_switcher` rows and is a no-op. Only `user_type` (and
// `updated_at`) change; education/skills/details/etc. are left untouched.
//
// Provenance: first run on 2026-07-14 — updated 8 rows (profile IDs
// f6598bc9, 778caf60, 7ac4ee2f, a4c68abf, 46349d96, 34c85bf6, adf30fda,
// 8c25f1cb), leaving 0 `job_switcher` rows. To reverse, set user_type back to
// 'job_switcher' on exactly those profile IDs.
//
// Run standalone:  npx tsx src/db/backfill/job-switcher-to-working-professional.ts
//            or:   npm run backfill:job-switcher
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../index";
import { userProfiles } from "../schema";

async function backfill() {
  // Snapshot the rows we're about to change (printed for provenance / reversal).
  const before = await db
    .select({ id: userProfiles.id, userId: userProfiles.userId })
    .from(userProfiles)
    .where(eq(userProfiles.userType, "job_switcher"));

  console.log(`job_switcher rows before: ${before.length}`);
  if (before.length === 0) {
    console.log("Nothing to backfill (already done or none present).");
    return;
  }
  console.log("affected profile IDs:", JSON.stringify(before.map((r) => r.id)));
  console.log("affected user IDs   :", JSON.stringify(before.map((r) => r.userId)));

  const updated = await db
    .update(userProfiles)
    .set({ userType: "working_professional", updatedAt: new Date() })
    .where(eq(userProfiles.userType, "job_switcher"))
    .returning({ id: userProfiles.id });
  console.log(`rows updated -> working_professional: ${updated.length}`);

  const after = await db
    .select({ id: userProfiles.id })
    .from(userProfiles)
    .where(eq(userProfiles.userType, "job_switcher"));
  console.log(`job_switcher rows after: ${after.length}`);
  if (after.length !== 0) {
    throw new Error(`Expected 0 job_switcher rows after backfill, found ${after.length}`);
  }
}

backfill()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("job_switcher backfill failed:", error);
    process.exit(1);
  });
