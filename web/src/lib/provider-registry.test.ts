import { describe, expect, test } from "bun:test";
import {
  connectionPicks,
  customEndpointNote,
  type ProviderType,
  probeToast,
} from "./provider-registry.ts";

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

describe("connectionPicks", () => {
  const served = [
    "z-ai/glm-5.3-flash",
    "z-ai/glm-5.3-flash:batch",
    "old/delisted",
    "~anthropic/claude-haiku-latest",
  ];
  const live = [
    "z-ai/glm-5.3-flash",
    "~anthropic/claude-haiku-latest",
    "brand/new-model",
    "other/newer",
  ];

  test("with nothing stored, the default is what is served and still listed by the host", () => {
    const picks = connectionPicks({ served, live, stored: null });
    expect(picks.selected).toEqual(["z-ai/glm-5.3-flash", "~anthropic/claude-haiku-latest"]);
    // Live models the bundled catalog lacks: shown as a count, never servable here.
    expect(picks.notInCatalog).toBe(2);
    expect(picks.notListed).toEqual([]);
  });

  test("a stored pick wins; what the host stopped listing is marked, not unticked", () => {
    const picks = connectionPicks({ served, live, stored: ["old/delisted", "z-ai/glm-5.3-flash"] });
    expect(picks.selected).toEqual(["old/delisted", "z-ai/glm-5.3-flash"]);
    expect(picks.notListed).toEqual(["old/delisted"]);
  });

  test("no live list (the probe failed) ticks everything served", () => {
    const picks = connectionPicks({ served, live: null, stored: null });
    expect(picks.selected).toEqual(served);
    expect(picks.notInCatalog).toBe(0);
  });
});

describe("customEndpointNote", () => {
  const openrouter = {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    endpointNote: "Claude models won't work here",
  } as ProviderType;

  test("a custom endpoint shows the type's note", () => {
    expect(customEndpointNote(openrouter, "https://us.openrouter.ai/api/v1")).toBe(
      "Claude models won't work here",
    );
  });

  test("blank or the catalog's own endpoint shows nothing", () => {
    for (const url of [
      "",
      "  ",
      "https://openrouter.ai/api/v1",
      "https://openrouter.ai/api/v1/ ",
    ]) {
      expect(customEndpointNote(openrouter, url)).toBeNull();
    }
  });

  test("a type without a note shows nothing", () => {
    const { endpointNote: _, ...together } = openrouter;
    expect(customEndpointNote(together as ProviderType, "https://elsewhere/v1")).toBeNull();
  });
});
