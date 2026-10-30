import { describe, expect, test } from "bun:test";
import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { filterServedModels } from "./allowlist.ts";

const FRAME = {
  type: "list_models_response",
  request_id: "r1",
  success: true,
  entries: [
    { id: "openrouter/z-ai/glm-5.3-flash", handle: "openrouter/z-ai/glm-5.3-flash", label: "GLM" },
    {
      id: "openrouter/amazon/nova-lite-v1",
      handle: "openrouter/amazon/nova-lite-v1",
      label: "Nova",
    },
    { id: "llama-3b/qwen3-4b-instruct", handle: "llama-3b/qwen3-4b-instruct", label: "Qwen" },
  ],
  available_handles: [
    "openrouter/z-ai/glm-5.3-flash",
    "openrouter/amazon/nova-lite-v1",
    "llama-3b/qwen3-4b-instruct",
  ],
} as unknown as WsProtocolMessage;

const HIDE_NOVA = new Map([["openrouter", new Set(["amazon/nova-lite-v1"])]]);

describe("filterServedModels", () => {
  test("a connection's hidden models leave both lists; everything else stays", () => {
    // What is not hidden stays, so a model a letta-code upgrade adds shows up on its own.
    const out = filterServedModels(FRAME, HIDE_NOVA) as unknown as {
      entries: { handle: string }[];
      available_handles: string[];
    };
    expect(out.available_handles).toEqual([
      "openrouter/z-ai/glm-5.3-flash",
      "llama-3b/qwen3-4b-instruct",
    ]);
    expect(out.entries.map((e) => e.handle)).toEqual([
      "openrouter/z-ai/glm-5.3-flash",
      "llama-3b/qwen3-4b-instruct",
    ]);
  });

  test("the frame the mirror saw is never mutated", () => {
    const before = JSON.stringify(FRAME);
    filterServedModels(FRAME, HIDE_NOVA);
    expect(JSON.stringify(FRAME)).toBe(before);
  });

  test("nothing hidden, or another frame type, passes through as the same object", () => {
    expect(filterServedModels(FRAME, new Map())).toBe(FRAME);
    const other = { type: "list_connect_providers_response" } as unknown as WsProtocolMessage;
    expect(filterServedModels(other, HIDE_NOVA)).toBe(other);
  });

  test("a failed lookup (null handles) is left alone", () => {
    const failed = { ...FRAME, available_handles: null } as unknown as WsProtocolMessage;
    expect(filterServedModels(failed, HIDE_NOVA)).toBe(failed);
  });
});
