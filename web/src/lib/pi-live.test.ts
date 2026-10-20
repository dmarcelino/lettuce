import { describe, expect, test } from "bun:test";
import type { PiRunFacts } from "./pi.ts";
import { applyPiProgressFrame, msSinceLastPiFrame, peekPiLiveRuns } from "./pi-live.ts";

const fact = (runId: string, state: string, eventCount = 1): PiRunFacts =>
  ({ runId, state, eventCount }) as unknown as PiRunFacts;

describe("pi-live store", () => {
  test("a frame lands in the snapshot and stamps the clock", () => {
    applyPiProgressFrame(fact("run-a", "running", 7));
    expect(peekPiLiveRuns()["run-a"]?.eventCount).toBe(7);
    expect(msSinceLastPiFrame()).toBeLessThan(1_000);
  });

  test("a later frame for the same run replaces it, and the snapshot is stable between frames", () => {
    const before = peekPiLiveRuns();
    applyPiProgressFrame(fact("run-a", "completed", 9));
    const after = peekPiLiveRuns();
    expect(after["run-a"]?.state).toBe("completed");
    expect(peekPiLiveRuns()).toBe(after);
    expect(after).not.toBe(before);
  });

  test("a frame without a run id is dropped, not stored under undefined", () => {
    applyPiProgressFrame({ state: "running" } as unknown as PiRunFacts);
    expect(peekPiLiveRuns().undefined).toBeUndefined();
  });

  test("the store stays capped: terminal frames go first, the oldest after them", () => {
    for (let i = 0; i < 40; i += 1) {
      applyPiProgressFrame(fact(`bulk-${i}`, i === 39 ? "running" : "completed"));
    }
    const kept = peekPiLiveRuns();
    expect(Object.keys(kept).length).toBeLessThanOrEqual(32);
    expect(kept["bulk-39"]?.state).toBe("running");
  });
});
