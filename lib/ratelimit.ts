/**
 * Dumb in-memory fixed-window rate limiter. Serverless-friendly to the
 * extent that a single warm instance will accumulate counts correctly;
 * cold starts and horizontally-scaled instances each get their own
 * counter. This is a safety rail against burst cost accidents (one bad
 * actor on a shared password, a stuck retry loop), not a DoS defense.
 * Swap for @upstash/ratelimit + Vercel KV once real traffic justifies it.
 */

type Bucket = { count: number; resetAt: number };

const WINDOW_MS = 60_000;

function limitPerMinute(): number {
  const raw = process.env.RATE_LIMIT_PER_MINUTE;
  if (!raw) return 20;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
}

// Module-scoped state. Next.js will reuse this Map inside a single server
// instance; each cold start begins fresh.
const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: number;
}

export function rateLimit(key: string): RateLimitResult {
  const limit = limitPerMinute();
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: limit - 1, limit, resetAt: now + WINDOW_MS };
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      limit,
      resetAt: existing.resetAt,
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: Math.max(0, limit - existing.count),
    limit,
    resetAt: existing.resetAt,
  };
}

export function clientKey(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  const real = req.headers.get('x-real-ip');
  if (real) return real;
  return 'anonymous';
}
