import { describe, expect, test } from "bun:test";
import { readStored } from "./storage.ts";

/** The fake every other storage test in this package uses. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
      writes.push(key);
    },
    get writes() {
      return writes;
    },
    dump: () => Object.fromEntries(data),
  };
}

describe("readStored", () => {
  test("reads the current key and writes nothing", () => {
    const storage = fakeStorage({ "lettuce:selection": "here" });
    expect(readStored(storage, "lettuce:selection")).toBe("here");
    expect(storage.writes).toEqual([]);
  });

  test("copies a value stored under the pre-lettuce prefix forward", () => {
    const storage = fakeStorage({ "letta-ui:selection": "from before" });
    expect(readStored(storage, "lettuce:selection")).toBe("from before");
    expect(storage.dump()).toEqual({
      "letta-ui:selection": "from before",
      "lettuce:selection": "from before",
    });
    // And the legacy entry survives, so rolling back keeps working.
    expect(readStored(storage, "lettuce:selection")).toBe("from before");
    expect(storage.writes.length).toBe(1);
  });

  test("the new key wins when both exist", () => {
    const storage = fakeStorage({ "letta-ui:draft": "old", "lettuce:draft": "new" });
    expect(readStored(storage, "lettuce:draft")).toBe("new");
  });

  test("no storage, no key, and a throwing store all read as nothing", () => {
    expect(readStored(null, "lettuce:selection")).toBeNull();
    expect(readStored(fakeStorage(), "lettuce:selection")).toBeNull();
    // A key outside the migrated namespace must not invent a legacy name.
    expect(readStored(fakeStorage({ other: "x" }), "other")).toBe("x");
    const angry = {
      getItem: () => {
        throw new Error("disabled");
      },
      setItem: () => {
        throw new Error("disabled");
      },
    };
    expect(readStored(angry, "lettuce:selection")).toBeNull();
  });
});
