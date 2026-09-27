import { expect, test } from "bun:test";
import { codexThreadInTaskText, formatDuration } from "./codex.ts";

test("the Codex thread comes from the notification's agent_id", () => {
  const text =
    "<result>subagent_type=codex subagent_id=subagent-1 subagent_status=completed " +
    "agent_id=codex_01a0e3cf-b69f-7eb0-8b79-4cc6ad0c0e9a</result>";
  expect(codexThreadInTaskText(text)).toBe("01a0e3cf-b69f-7eb0-8b79-4cc6ad0c0e9a");
});

test("a worker that never started, or a Letta subagent, has no thread", () => {
  expect(codexThreadInTaskText("agent_id=agent-local-5025acf5")).toBeNull();
  expect(codexThreadInTaskText("agent_id=codex_not-a-uuid")).toBeNull();
});

test("durations read naturally", () => {
  expect(formatDuration(45_000)).toBe("45s");
  expect(formatDuration(192_000)).toBe("3m 12s");
  expect(formatDuration(3_840_000)).toBe("1h 4m");
});
