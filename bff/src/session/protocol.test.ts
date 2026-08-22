import { describe, expect, test } from "bun:test";
import { WORKSPACE_ROOT, workspaceViolation } from "./protocol.ts";

/**
 * These assert a security boundary, not a preference. The app-server applies no
 * root of its own — `read_file` with an arbitrary absolute path succeeds — so
 * everything below is the only thing standing between a browser session and the
 * container filesystem.
 */
describe("workspace clamp", () => {
  const allow = (command: Record<string, unknown> & { type: string }) =>
    expect(workspaceViolation(command)).toBeNull();
  const refuse = (command: Record<string, unknown> & { type: string }) =>
    expect(workspaceViolation(command)).toBeString();

  test("paths inside the workspace are allowed", () => {
    allow({ type: "read_file", path: `${WORKSPACE_ROOT}/agent-1/notes.md` });
    allow({ type: "list_in_directory", path: WORKSPACE_ROOT });
    allow({ type: "get_tree", path: `${WORKSPACE_ROOT}/agent-1` });
  });

  test("the paths that are reachable today are refused", () => {
    refuse({ type: "read_file", path: "/root/.letta/settings.json" });
    refuse({ type: "list_in_directory", path: "/etc" });
    refuse({ type: "write_file", path: "/root/.letta/settings.json", content: "x" });
    refuse({ type: "get_tree", path: "/" });
  });

  test("traversal out of the workspace is refused after normalisation", () => {
    refuse({ type: "read_file", path: `${WORKSPACE_ROOT}/../root/.letta/settings.json` });
    refuse({ type: "read_file", path: `${WORKSPACE_ROOT}/agent-1/../../etc/passwd` });
    // Normalising back inside is fine.
    allow({ type: "read_file", path: `${WORKSPACE_ROOT}/agent-1/../agent-2/notes.md` });
    allow({ type: "read_file", path: `${WORKSPACE_ROOT}/./agent-1//notes.md` });
  });

  test("a prefix that merely starts with the root string is refused", () => {
    // "/workspace" must not pass just because it shares a prefix with "/work".
    refuse({ type: "list_in_directory", path: "/workspace" });
    refuse({ type: "read_file", path: "/work-other/secret" });
  });

  test("search_files and grep_in_files are clamped on cwd, not path", () => {
    refuse({ type: "grep_in_files", query: "token", cwd: "/root/.letta" });
    refuse({ type: "search_files", pattern: "*", cwd: "/etc" });
    allow({ type: "grep_in_files", query: "token", cwd: `${WORKSPACE_ROOT}/agent-1` });
    // Absent cwd means the server's own cwd, which compose anchors inside /work.
    allow({ type: "grep_in_files", query: "token" });
  });

  test("relative paths are refused rather than resolved", () => {
    refuse({ type: "read_file", path: "notes.md" });
    refuse({ type: "read_file", path: "../etc/passwd" });
    refuse({ type: "read_file", path: "" });
  });

  test("commands that carry no path are untouched", () => {
    allow({ type: "agent_list" });
    allow({ type: "list_models" });
    allow({ type: "execute_command", command_id: "compact" });
  });
});
