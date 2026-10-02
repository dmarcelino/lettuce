import { describe, expect, test } from "bun:test";
import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { ProviderSight } from "./sight.ts";

const deps = {
  request: async () => ({}),
  newRequestId: () => "r",
};

function models(handles: string[], extra: Record<string, unknown> = {}) {
  return {
    type: "list_models_response",
    success: true,
    available_handles: handles,
    entries: handles.map((handle) => ({
      handle,
      label: handle.split("/")[1],
      updateArgs: { context_window: 128000, max_output_tokens: 32000 },
    })),
    ...extra,
  } as unknown as WsProtocolMessage;
}

describe("ProviderSight", () => {
  test("folds a model list into prefixes with discovered windows", () => {
    const sight = new ProviderSight(deps);
    const result = sight.observe(models(["openai-compatible/Qwen", "openai-compatible/Phi"]));
    expect(result.modelsChanged).toBe(true);
    expect(sight.isLoaded()).toBe(true);
    expect(sight.servedModels("openai-compatible")?.map((m) => m.id)).toEqual(["Qwen", "Phi"]);
    expect(sight.servedModels("openai-compatible")?.[0]).toMatchObject({
      contextWindow: 128000,
      maxTokens: 32000,
      label: "Qwen",
    });
    // Same list again: no change.
    expect(
      sight.observe(models(["openai-compatible/Qwen", "openai-compatible/Phi"])).modelsChanged,
    ).toBe(false);
    // A new model under the prefix is a change.
    expect(
      sight.observe(
        models(["openai-compatible/Qwen", "openai-compatible/Phi", "openai-compatible/New"]),
      ).modelsChanged,
    ).toBe(true);
  });

  test("a failed lookup changes nothing", () => {
    const sight = new ProviderSight(deps);
    sight.observe(models(["p/a"]));
    expect(
      sight.observe({
        type: "list_models_response",
        success: false,
      } as unknown as WsProtocolMessage).modelsChanged,
    ).toBe(false);
    expect(sight.servedModels("p")?.map((m) => m.id)).toEqual(["a"]);
  });

  test("connections track base URLs and BYOK aliases borrow them", () => {
    const sight = new ProviderSight(deps);
    sight.observe({
      type: "list_connect_providers_response",
      providers: [
        {
          provider_names: ["openai-compatible"],
          connected: { is_connected: true, base_url: "http://live/v1" },
        },
      ],
    } as unknown as WsProtocolMessage);
    expect(sight.isConnected("openai-compatible")).toBe(true);
    expect(sight.baseUrlFor("openai-compatible")).toBe("http://live/v1");
    // An alias resolves base URL and liveness through its base.
    sight.observe(
      models(["lc-1/Qwen"], { byok_provider_aliases: { "lc-1": "openai-compatible" } }),
    );
    expect(sight.isConnected("lc-1")).toBe(true);
    expect(sight.baseUrlFor("lc-1")).toBe("http://live/v1");
    // A disconnect drops both.
    sight.observe({
      type: "list_connect_providers_response",
      providers: [{ provider_name: "openai-compatible", connected: { is_connected: false } }],
    } as unknown as WsProtocolMessage);
    expect(sight.isConnected("lc-1")).toBe(false);
    expect(sight.baseUrlFor("openai-compatible")).toBeUndefined();
  });

  test("connect/disconnect responses flag a possibly-changed model list", () => {
    const sight = new ProviderSight(deps);
    expect(
      sight.observe({ type: "connect_provider_response" } as unknown as WsProtocolMessage)
        .modelsMayHaveChanged,
    ).toBe(true);
    expect(
      sight.observe({
        type: "disconnect_provider_response",
        models_may_have_changed: false,
      } as unknown as WsProtocolMessage).modelsMayHaveChanged,
    ).toBe(false);
  });

  test("refresh pulls both lists through the caller", async () => {
    const calls: string[] = [];
    const sight = new ProviderSight({
      request: async (command) => {
        calls.push(command.type);
        if (command.type === "list_models") {
          return {
            success: true,
            available_handles: ["p/a"],
            entries: [],
          };
        }
        return {
          providers: [
            { provider_name: "p", connected: { is_connected: true, base_url: "http://p/v1" } },
          ],
        };
      },
      newRequestId: () => "r",
    });
    await Promise.all([sight.refresh(), sight.refresh()]);
    expect(calls).toEqual(["list_models", "list_connect_providers"]); // shared round trip
    expect(sight.servedModels("p")?.map((m) => m.id)).toEqual(["a"]);
    expect(sight.baseUrlFor("p")).toBe("http://p/v1");
  });
});
