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
    refuse({ type: "list_in_directory", path: "/etc" });
    refuse({ type: "get_tree", path: "/" });
    refuse({ type: "read_file", path: "/root/.letta/transcripts" });
  });

  test("settings.json is allowed, but only that exact file", () => {
    // MCP config has no protocol command; the MCP editor edits this file.
    allow({ type: "read_file", path: "/root/.letta/settings.json" });
    allow({ type: "write_file", path: "/root/.letta/settings.json", content: "{}" });
    // The exception must not extend to the directory around it.
    refuse({ type: "list_in_directory", path: "/root/.letta" });
    refuse({ type: "read_file", path: "/root/.letta/settings.json.bak-before-prune" });
    refuse({ type: "get_tree", path: "/root/.letta/projects" });
  });

  test("traversal out of the workspace is refused after normalisation", () => {
    // Note: traversal that resolves ONTO an allowed exact path is fine — the
    // exception is checked after normalisation, which is the point.
    refuse({ type: "read_file", path: `${WORKSPACE_ROOT}/../etc/passwd` });
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

  test("skill_enable is clamped on skill_path", () => {
    // A skill_enable symlinks whatever it is given into /root/.letta/skills,
    // where it loads for every agent — so an unclamped path here would hand a
    // browser session the whole filesystem to pick a SKILL.md out of.
    refuse({ type: "skill_enable", skill_path: "/root/.letta/skills" });
    refuse({ type: "skill_enable", skill_path: "/etc" });
    refuse({ type: "skill_enable", skill_path: `${WORKSPACE_ROOT}/../root` });
    allow({ type: "skill_enable", skill_path: `${WORKSPACE_ROOT}/agent-1/.agents/skills/thing` });
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
