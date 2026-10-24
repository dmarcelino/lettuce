import { describe, expect, test } from "bun:test";
import { groupByProvider, handleProvider, normalizeProviderKey } from "./providers.ts";

describe("normalizeProviderKey", () => {
  test("the case that shipped broken: hyphenated provider, dotted handle", () => {
    // list_connect_providers says "llama-cpp"; every served handle is "llama.cpp/…".
    expect(normalizeProviderKey("llama.cpp")).toBe(normalizeProviderKey("llama-cpp"));
  });

  test("the BYOK alias spelling matches too", () => {
    expect(normalizeProviderKey("lc-llama-cpp")).toBe(normalizeProviderKey("llama-cpp"));
  });

  test("only the leading alias marker is stripped", () => {
    expect(normalizeProviderKey("lc-lc-thing")).toBe("lcthing");
    expect(normalizeProviderKey("ollama-cloud")).toBe("ollamacloud");
  });
});

describe("handleProvider", () => {
  test("the first segment is the provider", () => {
    expect(handleProvider("llama.cpp/Gemma-4")).toBe("llama.cpp");
  });

  test("a model id with slashes is still one handle — upstream splits at the first", () => {
    expect(handleProvider("openrouter/deepseek/deepseek-chat-v3")).toBe("openrouter");
  });

  test("a handle with no slash is all provider", () => {
    expect(handleProvider("gpt-4o-mini")).toBe("gpt-4o-mini");
  });
});

describe("groupByProvider", () => {
  const model = (handle: string) => ({ handle });

  test("one group per provider, in the order the list gave them", () => {
    const groups = groupByProvider([model("llama.cpp/a"), model("QwenLM/b"), model("llama.cpp/c")]);
    expect(groups.map((group) => group.provider)).toEqual(["llama.cpp", "QwenLM"]);
    expect(groups[0]?.models.map((entry) => entry.handle)).toEqual(["llama.cpp/a", "llama.cpp/c"]);
  });

  test("an empty list groups to nothing, and one model is one group", () => {
    expect(groupByProvider([])).toEqual([]);
    expect(groupByProvider([model("x/1")])).toEqual([
      { provider: "x", models: [{ handle: "x/1" }] },
    ]);
  });

  test("a handle with no provider segment is its own group", () => {
    expect(groupByProvider([model("gpt-5")]).map((group) => group.provider)).toEqual(["gpt-5"]);
  });
});
