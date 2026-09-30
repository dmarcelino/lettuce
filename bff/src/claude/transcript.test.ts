import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  isClaudeSessionId,
  MAX_OUTPUT_CHARS,
  parseTranscript,
  RUNNING_WINDOW_MS,
  sessionIdFromAgentId,
} from "./transcript.ts";

const SESSION = "3218941e-1e45-471c-af5f-37f91e709f7a";
/** Recorded from a real 2.1.285 run against a mock endpoint, cut down. */
const FIXTURE = readFileSync(new URL("fixtures/claude-run.jsonl", import.meta.url), "utf8");
/** Everything in the fixture happened at 2026-09-30T17:21:27.4Z. */
const JUST_AFTER = Date.parse("2026-09-30T17:21:27.500Z");
const MUCH_LATER = Date.parse("2026-09-30T18:00:00.000Z");

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

describe("parseTranscript", () => {
  test("reads the recorded run: prompt, reasoning, messages, command with result", () => {
    const run = parseTranscript(SESSION, FIXTURE, JUST_AFTER);
    expect(run.cwd).toBe("/tmp/work");
    expect(run.model).toBe("mock-model");
    expect(run.prompt).toBe("Fix the failing test in math.test.js.");
    expect(run.steps.map((s) => s.kind)).toEqual([
      "prompt",
      "reasoning",
      "message",
      "command",
      "message",
    ]);
    const command = run.steps[3];
    expect(command).toMatchObject({
      kind: "command",
      tool: "Bash",
      input: JSON.stringify({ command: "node --test math.test.js" }),
      output: "1 test passed",
    });
    expect(run.usage).toEqual({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 });
    expect(run.durationMs).toBe(1524);
    expect(run.startedAt).toBe("2026-09-30T17:21:26.270Z");
  });

  test("sidechain entries are not the launched run's steps", () => {
    const run = parseTranscript(SESSION, FIXTURE, JUST_AFTER);
    expect(run.steps.some((s) => s.kind === "message" && s.text === "sidechain noise")).toBe(false);
  });

  test("a fresh file is running, an old one is completed, an empty one is unknown", () => {
    expect(parseTranscript(SESSION, FIXTURE, JUST_AFTER).status).toBe("running");
    expect(parseTranscript(SESSION, FIXTURE, MUCH_LATER).status).toBe("completed");
    expect(parseTranscript(SESSION, "", MUCH_LATER).status).toBe("unknown");
    // A long tool run leaves the file silent; just inside the window it is still running.
    expect(
      parseTranscript(SESSION, FIXTURE, Date.parse("2026-09-30T17:21:27.400Z") + RUNNING_WINDOW_MS)
        .status,
    ).toBe("running");
  });

  test("unknown entry types, broken lines and unknown parts are skipped", () => {
    const text = [
      line({ type: "queue-operation", timestamp: "2026-09-30T17:21:26Z" }),
      '{"type":"assistant","timestamp":"2026-09-30T17:21:26.5Z","message":{"role":"assistant","content":[{"type":"mystery-part","data":"?"}]}}',
      "{ this line is partial JSON",
      line({
        type: "assistant",
        timestamp: "2026-09-30T17:21:27Z",
        message: { role: "assistant", model: "m", content: [{ type: "text", text: "done" }] },
      }),
    ].join("\n");
    const run = parseTranscript(SESSION, text, MUCH_LATER);
    expect(run.steps).toEqual([{ kind: "message", text: "done", at: "2026-09-30T17:21:27Z" }]);
    expect(run.status).toBe("completed");
  });

  test("a tool result longer than the cap keeps its tail", () => {
    const huge = "x".repeat(MAX_OUTPUT_CHARS + 500);
    const text = [
      line({
        type: "assistant",
        timestamp: "2026-09-30T17:21:26Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "build" } }],
        },
      }),
      line({
        type: "user",
        timestamp: "2026-09-30T17:21:27Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: huge }],
        },
      }),
    ].join("\n");
    const command = parseTranscript(SESSION, text, MUCH_LATER).steps[0];
    expect(command).toMatchObject({ truncated: true });
    expect((command as { output: string }).output.endsWith("xxxx")).toBe(true);
    expect((command as { output: string }).output).toHaveLength(MAX_OUTPUT_CHARS);
  });
});

describe("session ids", () => {
  test("any hex UUID is a session id — not only UUIDv7, as Codex requires", () => {
    expect(isClaudeSessionId(SESSION)).toBe(true);
    expect(isClaudeSessionId("01a0e3cf-b69f-7eb0-7b79-4cc6ad0c0e9a")).toBe(true);
    expect(isClaudeSessionId("../../etc/passwd")).toBe(false);
    expect(isClaudeSessionId("3218941e-1e45-471c-af5f-37f91e709f7")).toBe(false);
  });

  test("claude_<uuid> carries the session id", () => {
    expect(sessionIdFromAgentId(`claude_${SESSION}`)).toBe(SESSION);
    expect(sessionIdFromAgentId("codex_01a0e3cf-b69f-7eb0-8b79-4cc6ad0c0e9a")).toBeNull();
    expect(sessionIdFromAgentId("claude_not-a-uuid")).toBeNull();
  });
});
