/**
 * Per-user throttling for the HTTP surface.
 *
 * The WebSocket command path has had a sliding-window limiter since the render
 * loop that drove the app-server to a 2GB heap (`session/registry.ts`). The
 * HTTP routes never got one, and they are the more expensive half: every
 * `/api/files/download` makes the app-server read a whole file and the BFF
 * hold it in memory, so a single misbehaving client can amplify one request
 * into as much memory as it can issue requests.
 *
 * Keyed by the authenticated email rather than by IP. In cloudflared mode
 * every request arrives from the tunnel's egress address, so an IP key would
 * lump every user together; the email is the identity the session cookie
 * already established. Anonymous requests get a single shared bucket, which
 * is the right shape for the handful of unauthenticated routes there are.
 *
 * Buckets are never evicted: there is one per signed-in address plus one
 * shared anonymous bucket, so the map is bounded by the allowlist and cannot
 * grow.
 */

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class HttpRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Take one token for `key`, or report the seconds until one is available.
   *
   * Returns null when allowed. A non-null return is a retry-after hint rather
   * than a precise wait, rounded up so a client never retries too early.
   */
  take(key: string): number | null {
    const nowMs = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, lastRefillMs: nowMs };

    const elapsedSeconds = (nowMs - bucket.lastRefillMs) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    bucket.lastRefillMs = nowMs;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      return null;
    }

    this.buckets.set(key, bucket);
    return Math.ceil((1 - bucket.tokens) / this.refillPerSecond);
  }
}

/**
 * A conservative default: enough that a person clicking around the Files tab
 * never notices it, low enough that a scripted flood is stopped rather than
 * served. Downloads are the expensive case, so the refill is deliberately
 * slower than a page-load burst would want.
 */
export const DEFAULT_HTTP_CAPACITY = 30;
export const DEFAULT_HTTP_REFILL_PER_SECOND = 5;
