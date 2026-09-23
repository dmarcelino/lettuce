import { describe, expect, test } from "bun:test";
import {
  addUsage,
  formatTokens,
  readTurnFinishedUsage,
  readUsageDelta,
  usageDescription,
  usageLabel,
} from "./usage.ts";

describe("readUsageDelta", () => {
  test("reads a local-executor usage chunk as one step", () => {
    expect(
      readUsageDelta({
        message_type: "usage_statistics",
        prompt_tokens: 1200,
        completion_tokens: 80,
        total_tokens: 1280,
        context_tokens: 5400,
      }),
    ).toEqual({ promptTokens: 1200, completionTokens: 80, steps: 1, contextTokens: 5400 });
  });

  test("ignores every other delta", () => {
    expect(readUsageDelta({ message_type: "assistant_message", content: "hi" })).toBeNull();
    expect(readUsageDelta(null)).toBeNull();
  });

  test("treats missing or junk counters as zero and omits unknown context", () => {
    expect(readUsageDelta({ message_type: "usage_statistics", prompt_tokens: "x" })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      steps: 1,
    });
  });
});

describe("readTurnFinishedUsage", () => {
  test("reads the listener's UsageStatistics shape", () => {
    expect(
      readTurnFinishedUsage({
        type: "turn_finished",
        usage: { prompt_tokens: 10, completion_tokens: 5, step_count: 3, context_tokens: 99 },
      }),
    ).toEqual({ promptTokens: 10, completionTokens: 5, steps: 3, contextTokens: 99 });
  });

  test("is null when the frame carries no usage", () => {
    expect(readTurnFinishedUsage({ type: "turn_finished" })).toBeNull();
  });
});

describe("addUsage", () => {
  test("sums counters across steps and keeps the latest context level", () => {
    const first = { promptTokens: 1000, completionTokens: 50, steps: 1, contextTokens: 4000 };
    const second = { promptTokens: 1100, completionTokens: 70, steps: 1, contextTokens: 4200 };
    expect(addUsage(addUsage(null, first), second)).toEqual({
      promptTokens: 2100,
      completionTokens: 120,
      steps: 2,
      contextTokens: 4200,
    });
  });

  test("a step without context keeps the previous level", () => {
    const first = { promptTokens: 1, completionTokens: 1, steps: 1, contextTokens: 10 };
    expect(addUsage(first, { promptTokens: 1, completionTokens: 1, steps: 1 }).contextTokens).toBe(
      10,
    );
  });
});

describe("formatting", () => {
  test("formatTokens", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });

  test("label and description", () => {
    const usage = { promptTokens: 12_000, completionTokens: 456, steps: 2, contextTokens: 18_200 };
    expect(usageLabel(usage)).toBe("18k ctx · 456 out");
    expect(usageLabel({ ...usage, contextTokens: undefined })).toBe("456 out");
    expect(usageDescription(usage)).toContain("2 steps");
  });
});
