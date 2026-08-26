import { describe, expect, test } from "bun:test";
import { EMPTY_SELECTION, readSelection, writeSelection } from "./selection.ts";

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
