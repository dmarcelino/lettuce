import { describe, expect, test } from "bun:test";
import { parseContextLimit, resolveContextLimit } from "./use-context-limit.ts";

describe("resolveContextLimit", () => {
  const agent = {
    model_settings: { context_window_limit: 128000 },
    llm_config: { context_window: 128000 },
  };

  test("the conversation's own limit wins", () => {
    expect(resolveContextLimit(agent, { context_window_limit: 262144 })).toEqual({
      tokens: 262144,
      source: "conversation",
    });
  });

  test("otherwise the agent's", () => {
    expect(resolveContextLimit(agent, {})).toEqual({ tokens: 128000, source: "agent" });
    expect(resolveContextLimit({ llm_config: { context_window: 64000 } }, null)).toEqual({
      tokens: 64000,
      source: "agent",
    });
  });

  test("otherwise letta-code's default", () => {
    expect(resolveContextLimit(null, null)).toEqual({ tokens: 128000, source: "default" });
  });
});

describe("parseContextLimit", () => {
  test("plain and grouped numbers", () => {
    expect(parseContextLimit("262144")).toBe(262144);
    expect(parseContextLimit("262,144")).toBe(262144);
    expect(parseContextLimit(" 200_000 ")).toBe(200000);
  });

  test("k: binary for power-of-two sizes, decimal otherwise", () => {
    expect(parseContextLimit("256k")).toBe(262144);
    expect(parseContextLimit("128K")).toBe(131072);
    expect(parseContextLimit("200k")).toBe(200000);
  });

  test("anything else is not a number", () => {
    expect(parseContextLimit("")).toBeNull();
    expect(parseContextLimit("lots")).toBeNull();
    expect(parseContextLimit("12m")).toBeNull();
  });
});
