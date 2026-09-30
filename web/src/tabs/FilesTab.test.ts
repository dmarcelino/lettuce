import { describe, expect, test } from "bun:test";
import { isEditableFile } from "../components/FileViewer.tsx";
import { newFilePath, parentDirectory, resolve } from "./FilesTab.tsx";

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

describe("New file", () => {
  test("a plain filename joins onto the current directory", () => {
    expect(newFilePath(AGENT, "notes.md")).toBe(`${AGENT}/notes.md`);
    expect(newFilePath(ROOT, "todo.txt")).toBe("/work/todo.txt");
    expect(newFilePath(AGENT, "  spaced name.md  ")).toBe(`${AGENT}/spaced name.md`);
  });

  test("path separators and traversal are refused", () => {
    // write_file mkdir -p's the parent, so an unchecked "a/b" would build "a".
    expect(newFilePath(AGENT, "a/b")).toBeNull();
    expect(newFilePath(AGENT, "a\\b")).toBeNull();
    expect(newFilePath(AGENT, "../escape")).toBeNull();
    expect(newFilePath(AGENT, "..")).toBeNull();
    expect(newFilePath(AGENT, ".")).toBeNull();
    expect(newFilePath(AGENT, "/etc/passwd")).toBeNull();
    expect(newFilePath(AGENT, "")).toBeNull();
    expect(newFilePath(AGENT, "   ")).toBeNull();
  });
});

describe("editable files", () => {
  test("text files are editable, images are not", () => {
    expect(isEditableFile("notes.md")).toBe(true);
    expect(isEditableFile("README")).toBe(true);
    expect(isEditableFile(".gitignore")).toBe(true);
    expect(isEditableFile("photo.png")).toBe(false);
    expect(isEditableFile("photo.jpeg")).toBe(false);
  });
});
