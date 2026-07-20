import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../../db";
import { rateLimits } from "../../db/schema";

// Fixed-window rate limiting, backed by Postgres (see the rate_limits table
// comment for why it is not in memory).
//
// FIXED WINDOW, not sliding or token bucket. A fixed window admits a burst across
// a boundary — up to 2x the limit in the two adjacent seconds — which a sliding
// window would not. Taken deliberately: the purpose here is to stop a runaway
// client or a scripted abuse loop from draining the LLM quota, and 2x a small
// limit still does that. The alternatives cost either a second table of
// timestamps per request or a read-then-write that the neon-http driver cannot
// make atomic. The cheap thing that works is the right trade at this size.

export type RateLimitConfig = {
  bucket: string;
  limit: number;
  windowMs: number;
};

export type RateLimitVerdict = {
  allowed: boolean;
  limit: number;
  remaining: number;
  // Seconds until the current window ends — fed straight to Retry-After.
  retryAfterSeconds: number;
};

// Per-endpoint limits. Set from what a person can plausibly do by hand, with
// generous headroom, since the cost of a false 429 is a user who thinks the
// product is broken. Chat is the expensive one (a full agent run: several LLM
// calls plus web search); resume upload is rarer but heavier per request.
export const CHAT_LIMIT: RateLimitConfig = {
  bucket: "chat",
  limit: 30,
  windowMs: 60 * 60 * 1000,
};

export const RESUME_LIMIT: RateLimitConfig = {
  bucket: "resume",
  limit: 10,
  windowMs: 60 * 60 * 1000,
};

export function userSubject(userId: string): string {
  return `user:${userId}`;
}

// Quantize to the window grid so concurrent requests in the same window compute
// the same row key — which is what makes the upsert below a single atomic
// increment rather than a race.
function windowStartFor(now: number, windowMs: number): Date {
  return new Date(Math.floor(now / windowMs) * windowMs);
}

// Occasionally delete windows that can no longer be current. Probabilistic rather
// than scheduled: this table has no reader other than this function, so stale rows
// are pure storage, and paying a delete on ~2% of requests keeps it bounded
// without a cron job or an extra round trip on the hot path.
async function maybeSweep(windowMs: number): Promise<void> {
  if (Math.random() > 0.02) return;
  try {
    const cutoff = new Date(Date.now() - windowMs * 2);
    await db.delete(rateLimits).where(lt(rateLimits.windowStart, cutoff));
  } catch (error) {
    console.error("rate-limit sweep failed:", error);
  }
}

// Records one request against (subject, bucket) and reports whether it is allowed.
//
// FAILS OPEN. If the counter cannot be read or written, the request proceeds and
// the error is logged. This is the deliberate choice for this system: the limiter
// protects a quota, it does not protect a secret, so a Neon blip taking the whole
// chat offline would do more damage than the handful of extra requests that slip
// through while it is down. A limiter guarding authentication or payment should
// make the opposite choice.
export async function consumeRateLimit(
  subject: string,
  config: RateLimitConfig,
  now: number = Date.now()
): Promise<RateLimitVerdict> {
  const { bucket, limit, windowMs } = config;
  const windowStart = windowStartFor(now, windowMs);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((windowStart.getTime() + windowMs - now) / 1000)
  );

  try {
    const [row] = await db
      .insert(rateLimits)
      .values({ subject, bucket, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimits.subject, rateLimits.bucket, rateLimits.windowStart],
        set: {
          count: sql`${rateLimits.count} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning({ count: rateLimits.count });

    const count = row?.count ?? 1;
    void maybeSweep(windowMs);

    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds,
    };
  } catch (error) {
    console.error(`rate limit check failed (bucket=${bucket}) — allowing:`, error);
    return { allowed: true, limit, remaining: limit, retryAfterSeconds };
  }
}

// Reads the current count without consuming. Exists for tests and diagnostics.
export async function peekRateLimit(
  subject: string,
  config: RateLimitConfig,
  now: number = Date.now()
): Promise<number> {
  const windowStart = windowStartFor(now, config.windowMs);
  const rows = await db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(
      and(
        eq(rateLimits.subject, subject),
        eq(rateLimits.bucket, config.bucket),
        eq(rateLimits.windowStart, windowStart)
      )
    );
  return rows[0]?.count ?? 0;
}
