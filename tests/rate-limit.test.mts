// Rate-limiter tests. LIVE — hits the real rate_limits table, because the whole
// point of the unit is that the counter is shared and atomic, and an in-memory
// stub would test the opposite of the property under test.
//
// Uses a synthetic subject ("test:<random>") so it never touches a real user's
// counters; `subject` has no foreign key, which is what makes that possible. All
// rows it creates are deleted at the end.
// Run: npm run test:ratelimit    (needs DATABASE_URL)
import "dotenv/config";
import { like } from "drizzle-orm";
import { db } from "../src/db";
import { rateLimits } from "../src/db/schema";
import {
  consumeRateLimit,
  peekRateLimit,
  type RateLimitConfig,
} from "../src/lib/rate-limit/queries";

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

const SUBJECT_PREFIX = "test:ratelimit:";
const subject = `${SUBJECT_PREFIX}${Math.floor(Math.random() * 1e9)}`;

const config: RateLimitConfig = {
  bucket: "test-bucket",
  limit: 3,
  windowMs: 60_000,
};

// A fixed timestamp mid-window, so the run is independent of when it executes and
// cannot straddle a real window boundary.
const T0 = 1_700_000_000_000;
const windowMid = T0 + 10_000;

try {
  console.log("\n== consumption within the window ==");
  const v1 = await consumeRateLimit(subject, config, windowMid);
  check("1st request allowed", v1.allowed);
  check("remaining counts down", v1.remaining === 2, String(v1.remaining));

  const v2 = await consumeRateLimit(subject, config, windowMid);
  const v3 = await consumeRateLimit(subject, config, windowMid);
  check("2nd allowed", v2.allowed);
  check("3rd allowed (at the limit)", v3.allowed);
  check("remaining hits zero at the limit", v3.remaining === 0, String(v3.remaining));

  console.log("\n== the limit actually blocks ==");
  const v4 = await consumeRateLimit(subject, config, windowMid);
  check("4th request blocked", !v4.allowed);
  check("remaining stays zero", v4.remaining === 0, String(v4.remaining));
  check("retry-after is a positive second count", v4.retryAfterSeconds > 0 && v4.retryAfterSeconds <= 60, String(v4.retryAfterSeconds));

  console.log("\n== the shared counter is real ==");
  const stored = await peekRateLimit(subject, config, windowMid);
  check("count persisted to Postgres", stored === 4, String(stored));

  console.log("\n== concurrent requests do not race ==");
  // The property the atomic upsert exists for: ten simultaneous increments must
  // land as ten. A read-then-write would lose several here.
  const raceSubject = `${SUBJECT_PREFIX}race:${Math.floor(Math.random() * 1e9)}`;
  await Promise.all(
    Array.from({ length: 10 }, () => consumeRateLimit(raceSubject, config, windowMid))
  );
  const raceCount = await peekRateLimit(raceSubject, config, windowMid);
  check("all 10 concurrent increments counted", raceCount === 10, String(raceCount));

  console.log("\n== the window rolls over ==");
  const nextWindow = windowMid + config.windowMs;
  const v5 = await consumeRateLimit(subject, config, nextWindow);
  check("allowed again in the next window", v5.allowed);
  check("count restarts in the new window", v5.remaining === 2, String(v5.remaining));
  check("previous window's count is untouched", (await peekRateLimit(subject, config, windowMid)) === 4);

  console.log("\n== separate buckets are independent ==");
  const other: RateLimitConfig = { ...config, bucket: "other-bucket" };
  const v6 = await consumeRateLimit(subject, other, windowMid);
  check("a different bucket has its own counter", v6.allowed && v6.remaining === 2, JSON.stringify(v6));
} finally {
  // Always clean up, including after a failed assertion.
  await db.delete(rateLimits).where(like(rateLimits.subject, `${SUBJECT_PREFIX}%`));
  console.log("\n(cleaned up test counters)");
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"} — passed: ${passed}, failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
