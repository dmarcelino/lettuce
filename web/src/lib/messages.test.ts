import { describe, expect, test } from "bun:test";
import {
  addLocalUserMessage,
  applyStreamDelta,
  createStreamIndex,
  type FilterGroup,
  filterEntries,
  settleStreaming,
  sortedEntries,
  type Transcript,
  transcriptFromHistory,
} from "./messages.ts";

function streamed(deltas: unknown[]): Transcript {
  const transcript: Transcript = new Map();
  const index = createStreamIndex();
  deltas.forEach((delta, seq) => {
    applyStreamDelta(transcript, index, delta, seq);
  });
  return transcript;
}

/**
 * One assistant text delta exactly as the local backend puts it on the wire.
 *
 * `id` is minted fresh per chunk by `createStoredChunk`, which also strips the
 * provider's own id; `otid` is memoized per contiguous content segment and is
 * the only field stable across a message. A real capture showed 98 deltas with
 * 98 distinct ids and 1 otid.
 */
let wireSeq = 400;
function textDelta(otid: string, text: string, messageType = "assistant_message") {
  wireSeq += 1;
  const key = messageType === "reasoning_message" ? "reasoning" : "content";
  return {
    type: "message",
    id: `letta-msg-${wireSeq}`,
    date: new Date(wireSeq).toISOString(),
    message_type: messageType,
    otid,
    [key]: messageType === "reasoning_message" ? text : [{ type: "text", text }],
  };
}

describe("streaming accumulation", () => {
  test("assistant text fragments concatenate into one entry", () => {
    // Every delta carries a DIFFERENT id and the SAME otid — the real wire.
    const transcript = streamed([
      textDelta("provider-assistant-1-aaa", "Hel"),
      textDelta("provider-assistant-1-aaa", "lo "),
      textDelta("provider-assistant-1-aaa", "there"),
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("Hello there");
    expect(entries[0]!.kind).toBe("assistant");
  });

  test("a new otid starts a new entry", () => {
    const transcript = streamed([
      textDelta("provider-assistant-1-aaa", "first"),
      textDelta("provider-assistant-3-bbb", "second"),
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.text)).toEqual(["first", "second"]);
  });

  test("reasoning deltas group by otid too", () => {
    const transcript = streamed([
      textDelta("provider-reasoning-0-ccc", "think", "reasoning_message"),
      textDelta("provider-reasoning-0-ccc", "ing", "reasoning_message"),
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("thinking");
    expect(entries[0]!.kind).toBe("reasoning");
  });

  test("a delta with an otid but no id is kept, not dropped", () => {
    const transcript = streamed([
      { type: "message", message_type: "assistant_message", otid: "o1", content: "raw " },
      { type: "message", message_type: "assistant_message", otid: "o1", content: "chunk" },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("raw chunk");
  });

  test("a stream mixing id-only and otid-only chunks stays one entry", () => {
    const transcript = streamed([
      { type: "message", id: "m1", message_type: "assistant_message", otid: "o9", content: "a" },
      { type: "message", id: "m1", message_type: "assistant_message", content: "b" },
      { type: "message", message_type: "assistant_message", otid: "o9", content: "c" },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("abc");
  });

  test("assistant and reasoning sharing one otid do not merge", () => {
    const transcript = streamed([
      textDelta("shared-otid", "spoken"),
      textDelta("shared-otid", "thought", "reasoning_message"),
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.kind).sort()).toEqual(["assistant", "reasoning"]);
  });

  test("tool call arguments accumulate across deltas", () => {
    const transcript = streamed([
      {
        type: "message",
        id: "letta-msg-500",
        date: "d",
        message_type: "tool_call_message",
        otid: "provider-tool-0-ddd",
        tool_call: { name: "Read", tool_call_id: "c1", arguments: '{"path":' },
      },
      {
        type: "message",
        id: "letta-msg-501",
        date: "d",
        message_type: "tool_call_message",
        otid: "provider-tool-0-ddd",
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
        content: [
          { type: "text", text: "part one " },
          { type: "text", text: "part two" },
        ],
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
      {
        type: "message",
        id: "h1",
        date: "d",
        message_type: "hidden_reasoning_message",
        state: "redacted",
      },
    ]);
    expect(sortedEntries(transcript)[0]!.redacted).toBe(true);
  });

  test("ordering follows first appearance, not id", () => {
    const transcript = streamed([
      { type: "message", id: "zzz", date: "d", message_type: "user_message", content: "first" },
      {
        type: "message",
        id: "aaa",
        date: "d",
        message_type: "assistant_message",
        content: "second",
      },
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
    {
      type: "message",
      id: "t",
      date: "d",
      message_type: "tool_call_message",
      tool_call: { name: "Bash" },
    },
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
    expect(filterEntries(entries, new Set<FilterGroup>(["system"])).map((e) => e.id)).toEqual([
      "s",
    ]);
  });
});

describe("system-reminder extraction", () => {
  // The opening line is what react-markdown swallows when the tag reaches it,
  // so every assertion below checks it explicitly.
  const REMINDER =
    "<system-reminder>\nThis is an automated message providing context about the user's environment.\n\nMore detail here.\n</system-reminder>";

  test("a reminder is split out of the user message as a System entry", () => {
    const transcript = transcriptFromHistory([
      {
        id: "u1",
        message_type: "user_message",
        content: [{ type: "text", text: `${REMINDER}\n\nWhat is the weather?` }],
      },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.kind)).toEqual(["system", "user"]);
    expect(entries[0]!.text).toContain("This is an automated message");
    expect(entries[0]!.text).not.toContain("<system-reminder>");
    expect(entries[1]!.text).toBe("What is the weather?");
  });

  test("a reminder-only message produces no empty user entry", () => {
    const transcript = transcriptFromHistory([
      { id: "u2", message_type: "user_message", content: REMINDER },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("system");
  });

  test("letta-guide blocks are extracted the same way", () => {
    const transcript = transcriptFromHistory([
      {
        id: "u3",
        message_type: "user_message",
        content: "<letta-guide>\n# Skill Directory\nstuff\n</letta-guide>\nhello",
      },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.kind).toBe("system");
    expect(entries[0]!.text).toContain("Skill Directory");
    expect(entries[1]!.text).toBe("hello");
  });

  test("extraction survives a reminder arriving across streaming deltas", () => {
    const transcript = streamed([
      { type: "message", id: "a", otid: "o1", message_type: "user_message", content: "<system-" },
      {
        type: "message",
        id: "b",
        otid: "o1",
        message_type: "user_message",
        content: "reminder>\nbody text\n</system-",
      },
      {
        type: "message",
        id: "c",
        otid: "o1",
        message_type: "user_message",
        content: "reminder>\nreal question",
      },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.kind).toBe("system");
    expect(entries[0]!.text).toBe("body text");
    expect(entries[1]!.text).toBe("real question");
  });

  test("reminders join the System filter group, not You", () => {
    const transcript = transcriptFromHistory([
      { id: "u4", message_type: "user_message", content: `${REMINDER}\n\nhi` },
    ]);
    const entries = sortedEntries(transcript);
    const system = filterEntries(entries, new Set<FilterGroup>(["system"]));
    expect(system).toHaveLength(1);
    expect(system[0]!.text).toContain("This is an automated message");
    const you = filterEntries(entries, new Set<FilterGroup>(["user"]));
    expect(you).toHaveLength(1);
    expect(you[0]!.text).toBe("hi");
  });

  test("a plain user message is untouched", () => {
    const transcript = transcriptFromHistory([
      { id: "u5", message_type: "user_message", content: "just a question" },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("user");
    expect(entries[0]!.text).toBe("just a question");
  });
});

describe("local user echo", () => {
  test("the user's own message shows immediately", () => {
    const transcript: Transcript = new Map();
    const index = createStreamIndex();
    addLocalUserMessage(transcript, index, "web-123", "tell me about your capabilities", 0);

    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("user");
    expect(entries[0]!.text).toBe("tell me about your capabilities");
    expect(entries[0]!.streaming).toBe(false);
  });

  test("a later server echo lands on the same entry, not a second one", () => {
    // The queued path DOES echo, carrying otid === client_message_id.
    const transcript: Transcript = new Map();
    const index = createStreamIndex();
    addLocalUserMessage(transcript, index, "web-123", "hello", 0);

    applyStreamDelta(
      transcript,
      index,
      {
        type: "message",
        id: "user-msg-abc",
        otid: "web-123",
        message_type: "user_message",
        content: "hello",
      },
      1,
    );

    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("hello");
  });

  test("a chunked echo replaces once, then accumulates", () => {
    const transcript: Transcript = new Map();
    const index = createStreamIndex();
    addLocalUserMessage(transcript, index, "web-9", "placeholder", 0);

    const echo = (content: string, seq: number) =>
      applyStreamDelta(
        transcript,
        index,
        {
          type: "message",
          id: `user-msg-${seq}`,
          otid: "web-9",
          message_type: "user_message",
          content,
        },
        seq,
      );
    echo("real ", 1);
    echo("text", 2);

    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    // First chunk replaced the local placeholder; the second appended.
    expect(entries[0]!.text).toBe("real text");
  });

  test("history reload replaces the local entry with the server record", () => {
    const transcript = transcriptFromHistory([
      { id: "ui-msg-16", message_type: "user_message", content: "hello" },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.local).toBeUndefined();
  });
});

describe("history ordering", () => {
  test("newest-first history renders oldest-first", () => {
    // conversation_messages_list returns descending by date.
    const transcript = transcriptFromHistory([
      { id: "m3", message_type: "assistant_message", content: "third" },
      { id: "m2", message_type: "user_message", content: "second" },
      { id: "m1", message_type: "assistant_message", content: "first" },
    ]);
    expect(sortedEntries(transcript).map((e) => e.text)).toEqual(["first", "second", "third"]);
  });

  test("a question sorts above the answer it prompted", () => {
    const transcript = transcriptFromHistory([
      { id: "a1", message_type: "assistant_message", content: "Here is the answer" },
      { id: "u1", message_type: "user_message", content: "What is it?" },
    ]);
    const entries = sortedEntries(transcript);
    expect(entries[0]!.kind).toBe("user");
    expect(entries[1]!.kind).toBe("assistant");
  });
});
