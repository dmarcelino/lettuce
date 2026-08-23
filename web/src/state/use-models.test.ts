import { describe, expect, test } from "bun:test";
import { sameHandleSet } from "./use-models.ts";

/**
 * This comparison is what flags an endpoint that load-balances its /models
 * route. Counts alone would miss it: two different backends can serve the same
 * number of models.
 */
describe("sameHandleSet", () => {
  test("identical lists match", () => {
    expect(sameHandleSet(["a/1", "a/2"], ["a/1", "a/2"])).toBe(true);
  });

  test("a reordered list is not a change", () => {
    expect(sameHandleSet(["a/1", "a/2"], ["a/2", "a/1"])).toBe(true);
  });

  test("a different set of the SAME size is a change", () => {
    // The case counts would miss.
    expect(sameHandleSet(["a/1", "a/2"], ["a/1", "a/3"])).toBe(false);
  });

  test("different sizes are a change", () => {
    expect(sameHandleSet(["a/1"], ["a/1", "a/2"])).toBe(false);
    expect(sameHandleSet([], ["a/1"])).toBe(false);
  });

  test("two empty lists match", () => {
    expect(sameHandleSet([], [])).toBe(true);
  });

  test("the real alternation this was written for", () => {
    const brainiac = ["llama.cpp/Qwen3.8-27B", "llama.cpp/unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL"];
    const ryzenE4b = ["llama.cpp/Gemma-4-E4B"];
    expect(sameHandleSet(brainiac, ryzenE4b)).toBe(false);
  });
});
