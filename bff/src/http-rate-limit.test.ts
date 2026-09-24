import { describe, expect, test } from "bun:test";
import { HttpRateLimiter } from "./http-rate-limit.ts";

describe("HttpRateLimiter", () => {
  test("allows a burst up to capacity then refuses", () => {
    const limiter = new HttpRateLimiter(3, 1, () => 0);
    expect(limiter.take("a")).toBeNull();
    expect(limiter.take("a")).toBeNull();
    expect(limiter.take("a")).toBeNull();
    expect(limiter.take("a")).toBe(1);
  });

  test("buckets are per key", () => {
    const limiter = new HttpRateLimiter(1, 1, () => 0);
    expect(limiter.take("a")).toBeNull();
    expect(limiter.take("b")).toBeNull();
    expect(limiter.take("a")).toBe(1);
  });

  test("tokens replenish over time", () => {
    let now = 0;
    const limiter = new HttpRateLimiter(2, 2, () => now);
    expect(limiter.take("a")).toBeNull();
    expect(limiter.take("a")).toBeNull();
    expect(limiter.take("a")).toBe(1);
    now = 1000; // 2 tokens replenished
    expect(limiter.take("a")).toBeNull();
  });

  test("never exceeds capacity no matter how long it idles", () => {
    let now = 0;
    const limiter = new HttpRateLimiter(2, 100, () => now);
    limiter.take("a");
    now = 1_000_000;
    expect(limiter.take("a")).toBeNull();
    expect(limiter.take("a")).toBeNull();
    expect(limiter.take("a")).toBe(1);
  });

  test("retry-after reflects the shortfall", () => {
    let now = 0;
    const limiter = new HttpRateLimiter(1, 0.5, () => now);
    limiter.take("a");
    // Half a token short of 1 after 1s at 0.5/s -> needs 1 more second.
    now = 1000;
    const retry = limiter.take("a");
    expect(retry).toBe(1);
  });
});
