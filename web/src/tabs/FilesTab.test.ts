import { describe, expect, test } from "bun:test";
import { parentDirectory, resolve } from "./FilesTab.tsx";

const ROOT = "/work";
const AGENT = "/work/agent-local-e596ee28-7374-4a66-b410-f4f8cab1abdf";

describe("Files navigation", () => {
  test("Up stops at the workspace root", () => {
    expect(parentDirectory(`${AGENT}/src`)).toBe(AGENT);
    expect(parentDirectory(AGENT)).toBe(ROOT);
    // The step that used to yield "/" and escape the workspace.
    expect(parentDirectory(ROOT)).toBeNull();
  });

  test("Up refuses to operate outside the workspace at all", () => {
    expect(parentDirectory("/")).toBeNull();
    expect(parentDirectory("/etc/ssl")).toBeNull();
    expect(parentDirectory("/workspace")).toBeNull();
  });

  test("trailing slashes do not produce an extra level", () => {
    expect(parentDirectory(`${AGENT}/src/`)).toBe(AGENT);
  });

  test("resolve never returns a root-relative path", () => {
    expect(resolve(ROOT, "agent-local-e596")).toBe("/work/agent-local-e596");
    expect(resolve(AGENT, "notes.md")).toBe(`${AGENT}/notes.md`);
    // The exact regression: root "/" used to collapse to "" and drop /work.
    expect(resolve("/", "agent-local-e596")).toBe("/agent-local-e596");
    expect(resolve(`${AGENT}/`, "notes.md")).toBe(`${AGENT}/notes.md`);
  });

  test("an already-absolute entry path passes through", () => {
    expect(resolve(AGENT, `${AGENT}/notes.md`)).toBe(`${AGENT}/notes.md`);
  });
});
