import { describe, expect, test } from "bun:test";
import { fetchContextLimit, parseContextLimit, resolveContextLimit } from "./use-context-limit.ts";

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

/**
 * The hook only sets the limit when this resolves to one, so null is the
 * "keep whatever was shown" answer — the point being that a lookup that never
 * reached the app-server must not resolve to the 128k default.
 */
describe("fetchContextLimit", () => {
  const succeed = (payload: Record<string, unknown>) =>
    (async (type: string) => payload[type] ?? {}) as never;

  test("a refused request (socket not open yet) yields null, not the 128k default", async () => {
    const request = (async () => {
      throw new Error("Not connected");
    }) as never;
    expect(await fetchContextLimit(request, "a1", "c1")).toBeNull();
  });

  test("a failed conversation lookup still resolves from the agent", async () => {
    const request = (async (type: string) => {
      if (type === "conversation_retrieve") throw new Error("boom");
      return { agent: { model_settings: { context_window_limit: 262144 } } };
    }) as never;
    expect(await fetchContextLimit(request, "a1", "c1")).toEqual({
      tokens: 262144,
      source: "agent",
    });
  });

  test("the default is only the answer when both lookups succeeded with no limit", async () => {
    const request = succeed({ agent_retrieve: { agent: {} } });
    expect(await fetchContextLimit(request, "a1", "c1")).toEqual({
      tokens: 128000,
      source: "default",
    });
  });

  test('the "default" conversation id is the agent scope and is not fetched', async () => {
    const seen: string[] = [];
    const request = (async (type: string) => {
      seen.push(type);
      return { agent: { llm_config: { context_window: 64000 } } };
    }) as never;
    expect(await fetchContextLimit(request, "a1", "default")).toEqual({
      tokens: 64000,
      source: "agent",
    });
    expect(seen).toEqual(["agent_retrieve"]);
  });
});
