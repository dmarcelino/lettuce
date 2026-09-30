import { expect, test } from "bun:test";
import { claudeSessionInTaskText, formatDuration } from "./claude.ts";

test("the Claude session comes from the notification's agent_id", () => {
  const text =
    "<result>subagent_type=claude-code subagent_id=subagent-1 subagent_status=completed " +
    "agent_id=claude_3218941e-1e45-471c-af5f-37f91e709f7a</result>";
  expect(claudeSessionInTaskText(text)).toBe("3218941e-1e45-471c-af5f-37f91e709f7a");
});

test("a plain UUIDv4 works — the v7-only Codex pattern would not", () => {
  // The id above is v4 (version nibble 4); codex.ts's regex demands 7 there.
  expect(claudeSessionInTaskText("agent_id=claude_01a0e3cf-b69f-7eb0-8b79-4cc6ad0c0e9a")).toBe(
    "01a0e3cf-b69f-7eb0-8b79-4cc6ad0c0e9a",
  );
});

test("a worker that never started, or a Letta subagent, has no session", () => {
  expect(claudeSessionInTaskText("agent_id=agent-local-5025acf5")).toBeNull();
  expect(claudeSessionInTaskText("agent_id=claude_not-a-uuid")).toBeNull();
  expect(claudeSessionInTaskText("agent_id=codex_01a0e3cf-b69f-7eb0-8b79-4cc6ad0c0e9a")).toBeNull();
});

test("durations read naturally", () => {
  expect(formatDuration(45_000)).toBe("45s");
  expect(formatDuration(192_000)).toBe("3m 12s");
  expect(formatDuration(3_840_000)).toBe("1h 4m");
});
