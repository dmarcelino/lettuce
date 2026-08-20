import { describe, expect, test } from "bun:test";
import {
  applyStreamDelta,
  filterEntries,
  settleStreaming,
  sortedEntries,
  transcriptFromHistory,
  type FilterGroup,
  type Transcript,
} from "./messages.ts";

function streamed(deltas: unknown[]): Transcript {
  const transcript: Transcript = new Map();
  deltas.forEach((delta, index) => applyStreamDelta(transcript, delta, index));
  return transcript;
}

describe("streaming accumulation", () => {
  test("assistant text fragments concatenate into one entry", () => {
    const transcript = streamed([
      { type: "message", id: "m1", date: "d", message_type: "assistant_message", content: "Hel" },
      { type: "message", id: "m1", date: "d", message_type: "assistant_message", content: "lo " },
      { type: "message", id: "m1", date: "d", message_type: "assistant_message", content: "there" },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("Hello there");
    expect(entries[0]!.kind).toBe("assistant");
  });

  test("tool call arguments accumulate across deltas", () => {
    const transcript = streamed([
      {
        type: "message",
        id: "t1",
        date: "d",
        message_type: "tool_call_message",
        tool_call: { name: "Read", tool_call_id: "c1", arguments: '{"path":' },
      },
      {
        type: "message",
        id: "t1",
        date: "d",
        message_type: "tool_call_message",
        tool_call: { arguments: '"/tmp/x"}' },
      },
    ]);
    const entry = sortedEntries(transcript)[0]!;
    expect(entry.toolName).toBe("Read");
    expect(entry.toolCallId).toBe("c1");
    expect(entry.toolArgs).toBe('{"path":"/tmp/x"}');
  });

  test("content arrays flatten to text", () => {
    const transcript = streamed([
      {
        type: "message",
        id: "u1",
        date: "d",
        message_type: "user_message",
        content: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }],
      },
    ]);
    expect(sortedEntries(transcript)[0]!.text).toBe("part one part two");
  });

  test("history replaces rather than appends, so a replay cannot double text", () => {
    const history = transcriptFromHistory([
      { id: "m1", date: "d", message_type: "assistant_message", content: "Hello there" },
      { id: "m1", date: "d", message_type: "assistant_message", content: "Hello there" },
    ]);
    expect(sortedEntries(history)[0]!.text).toBe("Hello there");
  });

  test("tool returns carry status", () => {
    const transcript = streamed([
      {
        type: "message",
        id: "r1",
        date: "d",
        message_type: "tool_return_message",
        tool_call_id: "c1",
        status: "error",
        tool_return: "boom",
      },
    ]);
    const entry = sortedEntries(transcript)[0]!;
    expect(entry.status).toBe("error");
    expect(entry.text).toBe("boom");
  });

  test("hidden reasoning is marked redacted", () => {
    const transcript = streamed([
      { type: "message", id: "h1", date: "d", message_type: "hidden_reasoning_message", state: "redacted" },
    ]);
    expect(sortedEntries(transcript)[0]!.redacted).toBe(true);
  });

  test("ordering follows first appearance, not id", () => {
    const transcript = streamed([
      { type: "message", id: "zzz", date: "d", message_type: "user_message", content: "first" },
      { type: "message", id: "aaa", date: "d", message_type: "assistant_message", content: "second" },
    ]);
    expect(sortedEntries(transcript).map((e) => e.text)).toEqual(["first", "second"]);
  });

  test("settleStreaming clears in-flight markers", () => {
    const transcript = streamed([
      { type: "message", id: "m1", date: "d", message_type: "assistant_message", content: "hi" },
    ]);
    expect(sortedEntries(transcript)[0]!.streaming).toBe(true);
    settleStreaming(transcript);
    expect(sortedEntries(transcript)[0]!.streaming).toBe(false);
  });
});

describe("lifecycle notices", () => {
  test("errors and retries surface with a level", () => {
    const transcript = streamed([
      { message_type: "loop_error", id: "e1", date: "d", message: "context overflow" },
      { message_type: "retry", id: "r1", date: "d", message: "retrying in 2s" },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries.map((e) => e.level)).toEqual(["error", "warning"]);
  });

  test("bare start markers are dropped", () => {
    const transcript = streamed([
      { message_type: "command_start", id: "c1", date: "d", command_id: "clear", input: "" },
    ]);
    expect(sortedEntries(transcript)).toHaveLength(0);
  });

  test("command output renders with its command name", () => {
    const transcript = streamed([
      {
        message_type: "command_end",
        id: "c1",
        date: "d",
        command_id: "compact",
        input: "",
        output: "done",
        success: true,
      },
    ]);
    expect(sortedEntries(transcript)[0]!.text).toBe("/compact\ndone");
  });
});

describe("filtering", () => {
  const transcript = streamed([
    { type: "message", id: "u", date: "d", message_type: "user_message", content: "u" },
    { type: "message", id: "a", date: "d", message_type: "assistant_message", content: "a" },
    { type: "message", id: "rs", date: "d", message_type: "reasoning_message", reasoning: "r" },
    { type: "message", id: "t", date: "d", message_type: "tool_call_message", tool_call: { name: "Bash" } },
    { type: "message", id: "s", date: "d", message_type: "system_message", content: "s" },
  ]);
  const entries = sortedEntries(transcript);

  test("no active filters shows everything", () => {
    expect(filterEntries(entries, new Set())).toHaveLength(5);
  });

  test("reasoning groups with agent responses", () => {
    const agent = filterEntries(entries, new Set<FilterGroup>(["agent"]));
    expect(agent.map((e) => e.id).sort()).toEqual(["a", "rs"]);
  });

  test("tools and system are separable", () => {
    expect(filterEntries(entries, new Set<FilterGroup>(["tools"])).map((e) => e.id)).toEqual(["t"]);
    expect(filterEntries(entries, new Set<FilterGroup>(["system"])).map((e) => e.id)).toEqual(["s"]);
  });
});
