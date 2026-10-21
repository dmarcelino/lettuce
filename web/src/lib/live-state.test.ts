import { describe, expect, test } from "bun:test";
import { indicatorStaysOn, seamAllowsFlip, stallProbeDue } from "./live-state.ts";

describe("the force-send seam", () => {
  test("with no send in flight, the indicator follows what the frame says", () => {
    expect(seamAllowsFlip(false, true)).toBe(true);
    expect(seamAllowsFlip(false, false)).toBe(true);
  });

  test("through the seam only busy moves it — the abort's own frames are lies", () => {
    expect(seamAllowsFlip(true, false)).toBe(false);
    expect(seamAllowsFlip(true, true)).toBe(true);
  });
});

describe("the working indicator across a turn boundary", () => {
  const queued = (paused: boolean) => ({ paused });

  test("nothing queued, the turn is over", () => {
    expect(indicatorStaysOn([])).toBe(false);
  });

  test("a ready item means the pump starts the next turn, so no blink", () => {
    expect(indicatorStaysOn([queued(true), queued(false)])).toBe(true);
  });

  test("items parked by an interrupt will not start, so they do not hold it on", () => {
    expect(indicatorStaysOn([queued(true), queued(true)])).toBe(false);
  });
});

describe("the stall watchdog's probe", () => {
  const STALL = 60_000;
  const due = (over: Partial<Parameters<typeof stallProbeDue>[0]>) =>
    stallProbeDue({
      probed: false,
      stopping: false,
      lastActivityAt: 1_000,
      now: 1_000 + STALL + 15_000,
      stallAfterMs: STALL,
      ...over,
    });

  test("due once the warning would already be showing", () => {
    expect(due({})).toBe(true);
    expect(due({ now: 1_000 + STALL + 14_999 })).toBe(false);
  });

  test("once per turn, and never while an abort is in flight", () => {
    expect(due({ probed: true })).toBe(false);
    expect(due({ stopping: true })).toBe(false);
  });

  test("a conversation that has heard nothing at all is not a stalled turn", () => {
    expect(due({ lastActivityAt: null })).toBe(false);
  });
});
