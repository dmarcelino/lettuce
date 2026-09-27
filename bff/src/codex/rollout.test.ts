import { describe, expect, test } from "bun:test";
import {
  candidateDayDirs,
  MAX_OUTPUT_CHARS,
  parseRollout,
  recentDayDirs,
  threadIdFromAgentId,
  threadIdOfRollout,
} from "./rollout.ts";

const THREAD = "01a0e3cf-b69f-7eb0-8b79-4cc6ad0c0e9a";

function line(type: string, payload: Record<string, unknown>, timestamp = "2026-09-27T17:00:36Z") {
  return JSON.stringify({ timestamp, type, payload });
}

/** The shape of a real Codex 0.157 rollout, cut down. */
const ROLLOUT = [
  line("session_meta", { id: THREAD, timestamp: "2026-09-27T17:00:35Z", cwd: "/work/agent-1" }),
  line("event_msg", { type: "task_started", turn_id: "t1" }),
  line("response_item", {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "<permissions instructions>…" }],
  }),
  line("response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/work</cwd>" }],
  }),
  line("response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Write gcd and test it." }],
  }),
  line("response_item", {
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Plan the files." }],
  }),
  line("response_item", {
    type: "message",
    id: "msg_1",
    role: "assistant",
    content: [{ type: "output_text", text: "Writing files." }],
  }),
  line("response_item", {
    type: "message",
    id: "msg_1",
    role: "assistant",
    content: [{ type: "output_text", text: "Writing files.\n" }],
  }),
  line("response_item", {
    type: "function_call",
    name: "exec_command",
    call_id: "call_a",
    arguments: JSON.stringify({ cmd: "python3 -m unittest" }),
  }),
  line("response_item", {
    type: "function_call_output",
    call_id: "call_a",
    output:
      "Chunk ID: x\nWall time: 0.1 seconds\nProcess exited with code 1\nOutput:\nFAILED (errors=1)\n",
  }),
  line("event_msg", {
    type: "token_count",
    info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } },
  }),
].join("\n");

describe("parseRollout", () => {
  test("keeps the prompt, reasoning, one copy of each message, and commands with results", () => {
    const run = parseRollout(THREAD, ROLLOUT);
    expect(run.cwd).toBe("/work/agent-1");
    expect(run.prompt).toBe("Write gcd and test it.");
    expect(run.steps.map((s) => s.kind)).toEqual(["prompt", "reasoning", "message", "command"]);
    const command = run.steps[3];
    expect(command).toMatchObject({
      kind: "command",
      tool: "exec_command",
      command: "python3 -m unittest",
      exitCode: 1,
      output: "FAILED (errors=1)\n",
      truncated: false,
    });
    expect(run.usage).toEqual({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 7 });
  });

  test("a run with no task_complete is still running", () => {
    expect(parseRollout(THREAD, ROLLOUT).status).toBe("running");
    const done = `${ROLLOUT}\n${line("event_msg", { type: "task_complete", duration_ms: 1234 }, "2026-09-27T17:01:00Z")}`;
    const run = parseRollout(THREAD, done);
    expect(run.status).toBe("completed");
    expect(run.durationMs).toBe(1234);
    expect(run.lastActivityAt).toBe("2026-09-27T17:01:00Z");
  });

  test("a partial last line from a file still being written is skipped", () => {
    const run = parseRollout(THREAD, `${ROLLOUT}\n{"timestamp":"2026-09-27T17:0`);
    expect(run.steps).toHaveLength(4);
  });

  test("a command still running has no output yet", () => {
    const text = [
      line("response_item", {
        type: "function_call",
        name: "exec_command",
        call_id: "call_b",
        arguments: '{"cmd":"sleep 60"}',
      }),
    ].join("\n");
    expect(parseRollout(THREAD, text).steps[0]).toMatchObject({ output: null, exitCode: null });
  });

  test("long output keeps its tail", () => {
    const long = `${"x".repeat(MAX_OUTPUT_CHARS)}END`;
    const text = [
      line("response_item", {
        type: "function_call",
        name: "exec_command",
        call_id: "c",
        arguments: '{"cmd":"make"}',
      }),
      line("response_item", { type: "function_call_output", call_id: "c", output: long }),
    ].join("\n");
    const step = parseRollout(THREAD, text).steps[0];
    expect(step).toMatchObject({ truncated: true });
    expect(step?.kind === "command" && step.output?.endsWith("END")).toBe(true);
  });
});

describe("locating rollouts", () => {
  test("the day directory comes from the UUIDv7 timestamp", () => {
    expect(candidateDayDirs(THREAD)[0]).toBe("2026/09/27");
  });

  test("recent days, newest first", () => {
    expect(recentDayDirs(Date.UTC(2026, 0, 1, 1), 2)).toEqual(["2026/01/01", "2025/12/31"]);
  });

  test("thread ids come from file names and agent ids, and nothing else passes", () => {
    expect(threadIdOfRollout(`rollout-2026-09-27T17-00-35-${THREAD}.jsonl`)).toBe(THREAD);
    expect(threadIdOfRollout("rollout-2026-09-27T17-00-35-../../x.jsonl")).toBeNull();
    expect(threadIdFromAgentId(`codex_${THREAD}`)).toBe(THREAD);
    expect(threadIdFromAgentId("codex_../../etc/passwd")).toBeNull();
    expect(threadIdFromAgentId("agent-local-1")).toBeNull();
  });
});
