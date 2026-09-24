import { describe, expect, test } from "bun:test";
import { symlinkViolation } from "./symlink-guard.ts";

/**
 * These drive an injected `lstat` rather than a real tree, so the exact
 * filesystem shape that makes a lexical path escape is pinned down without
 * depending on what happens to exist on the machine running the tests.
 */
const ROOT = "/work";

function fakeTree(links: string[], missing = false) {
  return (path: string) => {
    if (links.includes(path)) return { isSymbolicLink: () => true };
    if (missing) {
      const error = new Error("missing") as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    }
    return { isSymbolicLink: () => false };
  };
}

describe("symlinkViolation", () => {
  test("a plain path with no links is allowed", () => {
    expect(symlinkViolation("/work/agent-1/notes.md", ROOT, fakeTree([]))).toBeNull();
  });

  test("a symlinked leaf is refused", () => {
    expect(
      symlinkViolation("/work/agent-1/evil", ROOT, fakeTree(["/work/agent-1/evil"])),
    ).toBeString();
  });

  test("a symlinked intermediate component is refused", () => {
    // The actual attack: the path reads as inside the workspace, but the
    // middle of it points at /root/.letta.
    const violation = symlinkViolation(
      "/work/agent-1/link/settings.json",
      ROOT,
      fakeTree(["/work/agent-1/link"]),
    );
    expect(violation).toContain("/work/agent-1/link");
  });

  test("a symlinked root-adjacent directory is refused", () => {
    expect(symlinkViolation("/work/agent-1/x", ROOT, fakeTree(["/work/agent-1"]))).toContain(
      "/work/agent-1",
    );
  });

  test("a missing tail is allowed — write_file creates parents", () => {
    expect(symlinkViolation("/work/agent-1/new/dir/file.md", ROOT, fakeTree([], true))).toBeNull();
  });

  test("a missing intermediate is allowed, but a link further down still refuses", () => {
    expect(symlinkViolation("/work/a/b/c.md", ROOT, fakeTree(["/work/a/b"]))).toContain(
      "/work/a/b",
    );
  });

  test("an unreadable component is refused rather than trusted", () => {
    const throwing = (_path: string) => {
      const error = new Error("EACCES") as Error & { code: string };
      error.code = "EACCES";
      throw error;
    };
    expect(symlinkViolation("/work/agent-1/x", ROOT, throwing)).toContain("Cannot verify");
  });

  test("the root itself, with no relative part, is allowed", () => {
    expect(symlinkViolation(ROOT, ROOT, fakeTree([]))).toBeNull();
  });
});
