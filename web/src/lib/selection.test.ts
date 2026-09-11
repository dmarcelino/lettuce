import { describe, expect, test } from "bun:test";
import {
  EMPTY_SELECTION,
  readDeepLinkSelection,
  readSelection,
  writeSelection,
} from "./selection.ts";

/** A minimal Location/History stand-in — `bun:test` has no DOM `window`. */
function fakeLocation(search: string, pathname = "/") {
  return { pathname, search };
}

function fakeHistory() {
  const calls: { data: unknown; unused: string; url?: string | URL | null }[] = [];
  return {
    replaceState: (data: unknown, unused: string, url?: string | URL | null) => {
      calls.push({ data, unused, url });
    },
    calls,
  };
}

/** A Storage stand-in; `bun:test` has no DOM localStorage to lean on. */
function fakeStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    read: (key: string) => data.get(key) ?? null,
  };
}

/** Storage that throws on every access, as a disabled or sandboxed one does. */
const hostileStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("selection memory", () => {
  test("a written selection reads back", () => {
    const storage = fakeStorage();
    writeSelection({ agentId: "agent-resume", conversationId: "conv-7" }, storage);
    expect(readSelection(storage)).toEqual({
      agentId: "agent-resume",
      conversationId: "conv-7",
    });
  });

  test("nothing stored reads as empty", () => {
    expect(readSelection(fakeStorage())).toEqual(EMPTY_SELECTION);
  });

  test("the pair is stored under one key, so it cannot half-update", () => {
    const storage = fakeStorage();
    writeSelection({ agentId: "a", conversationId: "c" }, storage);
    const keys = ["letta-ui:selection"];
    expect(JSON.parse(storage.read(keys[0]!) ?? "null")).toEqual({
      agentId: "a",
      conversationId: "c",
    });
  });

  test("a partial selection round-trips", () => {
    const storage = fakeStorage();
    writeSelection({ agentId: "a", conversationId: null }, storage);
    expect(readSelection(storage)).toEqual({ agentId: "a", conversationId: null });
  });

  test("corrupt or foreign JSON reads as empty rather than throwing", () => {
    expect(readSelection(fakeStorage({ "letta-ui:selection": "not json" }))).toEqual(
      EMPTY_SELECTION,
    );
    expect(readSelection(fakeStorage({ "letta-ui:selection": "[1,2,3]" }))).toEqual(
      EMPTY_SELECTION,
    );
    // Right shape, wrong types — a value we did not write.
    expect(readSelection(fakeStorage({ "letta-ui:selection": '{"agentId":42}' }))).toEqual(
      EMPTY_SELECTION,
    );
  });

  test("storage that throws degrades to no memory", () => {
    expect(readSelection(hostileStorage)).toEqual(EMPTY_SELECTION);
    expect(() =>
      writeSelection({ agentId: "a", conversationId: "c" }, hostileStorage),
    ).not.toThrow();
  });

  test("absent storage is not an error", () => {
    expect(readSelection(null)).toEqual(EMPTY_SELECTION);
    expect(() => writeSelection({ agentId: "a", conversationId: "c" }, null)).not.toThrow();
  });
});

describe("deep-link selection", () => {
  test("query params win over the persisted selection, and are stripped", () => {
    const storage = fakeStorage();
    writeSelection({ agentId: "persisted-agent", conversationId: "persisted-conv" }, storage);
    const history = fakeHistory();

    const result = readDeepLinkSelection(
      storage,
      fakeLocation("?agent=deep-agent&conversation=deep-conv"),
      history,
    );

    expect(result).toEqual({ agentId: "deep-agent", conversationId: "deep-conv" });
    expect(history.calls).toEqual([{ data: null, unused: "", url: "/" }]);
  });

  test("with no query params, falls back to the persisted selection untouched", () => {
    const storage = fakeStorage();
    writeSelection({ agentId: "persisted-agent", conversationId: "persisted-conv" }, storage);
    const history = fakeHistory();

    const result = readDeepLinkSelection(storage, fakeLocation(""), history);

    expect(result).toEqual({ agentId: "persisted-agent", conversationId: "persisted-conv" });
    expect(history.calls).toEqual([]);
  });

  test("an unrelated query param is preserved after stripping agent/conversation", () => {
    const history = fakeHistory();

    const result = readDeepLinkSelection(
      fakeStorage(),
      fakeLocation("?agent=deep-agent&other=1"),
      history,
    );

    expect(result).toEqual({ agentId: "deep-agent", conversationId: null });
    expect(history.calls).toEqual([{ data: null, unused: "", url: "?other=1" }]);
  });

  test("a history API that throws still returns the parsed deep link", () => {
    const result = readDeepLinkSelection(fakeStorage(), fakeLocation("?agent=deep-agent"), {
      replaceState: () => {
        throw new Error("blocked");
      },
    });

    expect(result).toEqual({ agentId: "deep-agent", conversationId: null });
  });
});
