import { describe, expect, test } from "bun:test";
import {
  isCapabilityLessHandle,
  isLocalHandle,
  localProviderKeys,
  normalizeProviderKey,
} from "./providers.ts";

/** Exactly what `list_connect_providers` returns for this deployment. */
const LLAMA_CPP = { provider_name: "llama-cpp", provider_names: ["llama-cpp", "lc-llama-cpp"] };
const OLLAMA = { provider_name: "ollama", provider_names: ["ollama", "lc-ollama"] };

describe("local vs cloud model handles", () => {
  test("the case that shipped broken: hyphenated provider, dotted handle", () => {
    // provider_names carry "llama-cpp"; every served handle is "llama.cpp/…".
    const keys = localProviderKeys([LLAMA_CPP]);
    expect(isLocalHandle("llama.cpp/Gemma-4-E4B", keys)).toBe(true);
  });

  test("the BYOK alias spelling also matches", () => {
    const keys = localProviderKeys([LLAMA_CPP]);
    expect(isLocalHandle("lc-llama-cpp/Gemma-4-E4B", keys)).toBe(true);
    expect(isLocalHandle("llama-cpp/Gemma-4-E4B", keys)).toBe(true);
  });

  test("cloud handles stay cloud", () => {
    const keys = localProviderKeys([LLAMA_CPP, OLLAMA]);
    expect(isLocalHandle("letta/auto", keys)).toBe(false);
    expect(isLocalHandle("anthropic/claude-sonnet-4-6", keys)).toBe(false);
    expect(isLocalHandle("openai/gpt-5.5", keys)).toBe(false);
    expect(isLocalHandle("openrouter/whatever", keys)).toBe(false);
  });

  test("other local providers match on their own name", () => {
    const keys = localProviderKeys([OLLAMA]);
    expect(isLocalHandle("ollama/llama3", keys)).toBe(true);
  });

  test("a served local handle is classified even with no provider row", () => {
    // The list response can omit a row; the mirrored prefix list is the net.
    expect(isLocalHandle("llama.cpp/Gemma-4-E4B", new Set())).toBe(true);
    expect(isLocalHandle("lmstudio/x", new Set())).toBe(true);
    expect(isLocalHandle("anthropic/x", new Set())).toBe(false);
  });

  test("normalisation folds separators and the lc- alias marker", () => {
    expect(normalizeProviderKey("llama.cpp")).toBe("llamacpp");
    expect(normalizeProviderKey("llama-cpp")).toBe("llamacpp");
    expect(normalizeProviderKey("lc-llama-cpp")).toBe("llamacpp");
    expect(normalizeProviderKey("LLAMA_CPP")).toBe("llamacpp");
    // Not an alias marker, just a name starting with those letters.
    expect(normalizeProviderKey("lcm-thing")).toBe("lcmthing");
  });

  test("a handle with no provider segment is not local", () => {
    expect(isLocalHandle("", new Set(["llamacpp"]))).toBe(false);
  });
});

describe("isCapabilityLessHandle", () => {
  test("a plain openai-compatible prefix is capability-less", () => {
    expect(isCapabilityLessHandle("openai-compatible/Qwen", {})).toBe(true);
    expect(isCapabilityLessHandle("lc-openai-compatible/Qwen", {})).toBe(true);
  });

  test("a BYOK alias resolves through byok_provider_aliases", () => {
    expect(isCapabilityLessHandle("lc-1/Qwen", { "lc-1": "openai-compatible" })).toBe(true);
    // An alias of a capability-reporting provider is not editable.
    expect(isCapabilityLessHandle("lc-2/Qwen", { "lc-2": "ollama" })).toBe(false);
    // An alias the list never mentioned: unknown, so not editable.
    expect(isCapabilityLessHandle("lc-3/Qwen", {})).toBe(false);
  });

  test("native endpoints report their own capabilities", () => {
    expect(isCapabilityLessHandle("llama.cpp/Gemma", {})).toBe(false);
    expect(isCapabilityLessHandle("ollama/llama3", {})).toBe(false);
    expect(isCapabilityLessHandle("anthropic/claude-sonnet-4-6", {})).toBe(false);
  });
});
