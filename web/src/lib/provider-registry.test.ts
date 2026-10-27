import { describe, expect, test } from "bun:test";
import { probeToast } from "./provider-registry.ts";

describe("probeToast", () => {
  test("a connection's probe only proves the key", () => {
    expect(probeToast({ models: ["a/b", "c/d"], skipped: [] }, true)).toBe(
      "reachable — key accepted",
    );
  });

  test("a named provider counts what it can register and what it skipped", () => {
    expect(probeToast({ models: ["a", "b", "c"], skipped: ["x/y", "~z"] }, false)).toBe(
      "reachable — 3 models, 2 skipped",
    );
    expect(probeToast({ models: ["a"], skipped: [] }, false)).toBe("reachable — 1 model");
  });
});
