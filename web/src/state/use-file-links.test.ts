import { describe, expect, test } from "bun:test";
import { FileLinkCache, pickResolvedFile } from "./use-file-links.ts";

describe("pickResolvedFile", () => {
  const files = (...paths: string[]) => paths.map((path) => ({ path, type: "file" }));

  test("a bare name resolves to its one nested hit", () => {
    expect(pickResolvedFile("monitor.md", files(".claude/skills/pkg/references/monitor.md"))).toBe(
      ".claude/skills/pkg/references/monitor.md",
    );
  });

  test("a substring collision on the tail does not count", () => {
    // search_files substring-matches, so a query for LOG.md also returns this.
    expect(pickResolvedFile("LOG.md", files("CHANGELOG.md"))).toBeNull();
  });

  test("an exact top-level match resolves", () => {
    expect(pickResolvedFile("EVAL.md", files("EVAL.md", "history/EVAL.md.bak"))).toBe("EVAL.md");
  });

  test("a token with its own directories must match that whole tail", () => {
    expect(
      pickResolvedFile("scripts/monitor_linkedin.py", files("scripts/monitor_linkedin.py")),
    ).toBe("scripts/monitor_linkedin.py");
    expect(
      pickResolvedFile("bin/monitor_linkedin.py", files("scripts/monitor_linkedin.py")),
    ).toBeNull();
  });

  test("two equally-good hits are ambiguous — no link", () => {
    expect(pickResolvedFile("notes.md", files("a/notes.md", "b/notes.md"))).toBeNull();
  });

  test("no hits — no link", () => {
    expect(pickResolvedFile("nope.md", files("EVAL.md"))).toBeNull();
  });

  test("directory entries are ignored", () => {
    expect(
      pickResolvedFile("build.md", [
        { path: "build.md", type: "dir" },
        { path: "docs/build.md", type: "file" },
      ]),
    ).toBe("docs/build.md");
  });
});

describe("FileLinkCache", () => {
  test("a hit is returned and never expires", () => {
    const cache = new FileLinkCache();
    cache.set("a.md", "/work/x/a.md", 0);
    expect(cache.get("a.md", 0)).toBe("/work/x/a.md");
    expect(cache.get("a.md", 10 ** 12)).toBe("/work/x/a.md");
  });

  test("a miss is remembered, then forgotten after the TTL", () => {
    const cache = new FileLinkCache(500, 60_000);
    cache.set("gone.md", null, 1_000);
    expect(cache.get("gone.md", 1_000)).toBeNull();
    expect(cache.get("gone.md", 30_000)).toBeNull();
    // TTL elapsed: back to "unknown" so it will be looked up again.
    expect(cache.get("gone.md", 61_001)).toBeUndefined();
  });

  test("unknown() reports only tokens not currently cached", () => {
    const cache = new FileLinkCache(500, 60_000);
    cache.set("hit.md", "/work/x/hit.md", 0);
    cache.set("miss.md", null, 0);
    expect(cache.unknown(["hit.md", "miss.md", "new.md"], 1_000)).toEqual(["new.md"]);
    // Once the miss expires it is unknown again.
    expect(cache.unknown(["hit.md", "miss.md", "new.md"], 61_001)).toEqual(["miss.md", "new.md"]);
  });

  test("eviction drops the oldest entries past the cap", () => {
    const cache = new FileLinkCache(2, 60_000);
    cache.set("one.md", "/1", 0);
    cache.set("two.md", "/2", 0);
    cache.set("three.md", "/3", 0);
    expect(cache.get("one.md", 0)).toBeUndefined();
    expect(cache.get("two.md", 0)).toBe("/2");
    expect(cache.get("three.md", 0)).toBe("/3");
  });

  test("re-setting a token makes it the newest, not the oldest", () => {
    const cache = new FileLinkCache(2, 60_000);
    cache.set("one.md", "/1", 0);
    cache.set("two.md", "/2", 0);
    cache.set("one.md", "/1b", 0); // refreshes one.md
    cache.set("three.md", "/3", 0); // evicts two.md, not one.md
    expect(cache.get("one.md", 0)).toBe("/1b");
    expect(cache.get("two.md", 0)).toBeUndefined();
    expect(cache.get("three.md", 0)).toBe("/3");
  });

  test("clear() empties everything", () => {
    const cache = new FileLinkCache();
    cache.set("a.md", "/a", 0);
    cache.clear();
    expect(cache.get("a.md", 0)).toBeUndefined();
  });
});
