import { describe, expect, test } from "bun:test";
import {
  addUsage,
  contextGauge,
  formatTokens,
  readStoredUsage,
  readTurnFinishedUsage,
  readUsageDelta,
  writeStoredUsage,
} from "./usage.ts";

describe("readUsageDelta", () => {
  test("reads a local-executor usage chunk as one step", () => {
    expect(
      readUsageDelta({
        message_type: "usage_statistics",
        prompt_tokens: 25445,
        completion_tokens: 16,
        reasoning_tokens: 13,
        context_tokens: 25461,
      }),
    ).toEqual({
      promptTokens: 25445,
      lastPromptTokens: 25445,
      completionTokens: 16,
      reasoningTokens: 13,
      steps: 1,
      contextTokens: 25461,
    });
  });

  test("ignores every other delta", () => {
    expect(readUsageDelta({ message_type: "assistant_message" })).toBeNull();
    expect(readUsageDelta(null)).toBeNull();
  });

  test("treats missing or junk counters as zero and omits unknown context", () => {
    expect(readUsageDelta({ message_type: "usage_statistics", prompt_tokens: "x" })).toEqual({
      promptTokens: 0,
      lastPromptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      steps: 1,
    });
  });
});

describe("readTurnFinishedUsage", () => {
  test("reads the listener's UsageStatistics shape", () => {
    const usage = readTurnFinishedUsage({
      usage: { prompt_tokens: 10, completion_tokens: 5, step_count: 3, context_tokens: 99 },
    });
    expect(usage).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
      steps: 3,
      contextTokens: 99,
    });
  });

  test("is null when the frame carries no usage", () => {
    expect(readTurnFinishedUsage({ type: "turn_finished" })).toBeNull();
  });
});

describe("addUsage", () => {
  test("sums across steps; the last prompt and the context level are the latest", () => {
    const first = readUsageDelta({
      message_type: "usage_statistics",
      prompt_tokens: 20000,
      completion_tokens: 100,
      reasoning_tokens: 40,
      context_tokens: 20100,
    });
    const second = readUsageDelta({
      message_type: "usage_statistics",
      prompt_tokens: 20400,
      completion_tokens: 50,
      reasoning_tokens: 10,
      context_tokens: 20450,
    });
    expect(addUsage(addUsage(null, first!), second!)).toEqual({
      promptTokens: 40400,
      lastPromptTokens: 20400,
      completionTokens: 150,
      reasoningTokens: 50,
      steps: 2,
      contextTokens: 20450,
    });
  });

  test("a step without context keeps the previous level", () => {
    const first = readUsageDelta({ message_type: "usage_statistics", context_tokens: 500 });
    const second = readUsageDelta({ message_type: "usage_statistics", prompt_tokens: 1 });
    expect(addUsage(addUsage(null, first!), second!).contextTokens).toBe(500);
  });
});

describe("contextGauge", () => {
  test("label, percent, and the amber threshold", () => {
    expect(contextGauge(25461, 128000)).toEqual({ label: "25k / 128k", percent: 20, warn: false });
    expect(contextGauge(108000, 128000)).toMatchObject({ percent: 84, warn: true });
    expect(contextGauge(300000, 128000).percent).toBe(100);
    expect(contextGauge(10, 0).percent).toBe(0);
  });

  test("formatTokens", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });
});

describe("stored usage", () => {
  const memory = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  };

  test("round-trips per conversation", () => {
    const storage = memory();
    const usage = readUsageDelta({
      message_type: "usage_statistics",
      prompt_tokens: 7,
      context_tokens: 9,
    })!;
    writeStoredUsage("a::c1", usage, storage);
    expect(readStoredUsage("a::c1", storage)).toEqual(usage);
    expect(readStoredUsage("a::c2", storage)).toBeNull();
  });

  test("keeps only the 50 most recent conversations", () => {
    const storage = memory();
    const usage = readUsageDelta({ message_type: "usage_statistics", prompt_tokens: 1 })!;
    for (let i = 0; i < 55; i++) writeStoredUsage(`a::c${i}`, usage, storage);
    expect(readStoredUsage("a::c0", storage)).toBeNull();
    expect(readStoredUsage("a::c54", storage)).not.toBeNull();
  });

  test("no storage is no memory, not a crash", () => {
    expect(readStoredUsage("x", null)).toBeNull();
  });
});
