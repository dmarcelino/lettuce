import { describe, expect, test } from "bun:test";
import type { LiveSubagent, WorkflowCounts } from "./subagents.ts";
import {
  childActivityLabel,
  pickRunningChild,
  subagentStatusLine,
  workflowPhasesLine,
  workflowStatusLine,
} from "./subagents.ts";

function sub(over: Partial<LiveSubagent> = {}): LiveSubagent {
  return {
    status: "running",
    subagentType: "general-purpose",
    description: "research flights",
    toolCalls: [],
    totalTokens: 0,
    durationMs: 0,
    ...over,
  };
}

const workflow: WorkflowCounts = {
  total: 8,
  done: 5,
  failed: 1,
  running: 2,
  tokens: 140_000,
  phases: [
    { title: "plan", total: 4, done: 4, failed: 0, running: 0, tokens: 10 },
    { title: "build", total: 4, done: 1, failed: 1, running: 2, tokens: 20 },
  ],
};

describe("pickRunningChild", () => {
  test("prefers the exact tool_call_id match", () => {
    const a = sub({ toolCallId: "tc_a", description: "a" });
    const b = sub({ toolCallId: "tc_b", description: "b" });
    expect(pickRunningChild({ s1: a, s2: b }, "tc_b")).toBe(b);
  });

  test("falls back to the single running child", () => {
    const only = sub();
    expect(pickRunningChild({ s1: only, s2: sub({ status: "pending" }) }, "tc_x")).toBe(only);
  });

  test("several running children without an id match stay ambiguous", () => {
    expect(pickRunningChild({ s1: sub(), s2: sub() }, "tc_x")).toBeNull();
    expect(pickRunningChild({}, undefined)).toBeNull();
  });
});

describe("childActivityLabel", () => {
  test("summarises the last tool call with the transcript's own grammar", () => {
    const child = sub({
      toolCalls: [
        { name: "Read", args: '{"file_path":"/work/repo/web/src/App.tsx"}' },
        { name: "Bash", args: '{"command":"bun test bff"}' },
      ],
    });
    expect(childActivityLabel(child, null)).toBe("bun test bff");
  });

  test("a child between tools is thinking", () => {
    expect(childActivityLabel(sub(), null)).toBe("thinking");
  });

  test("an unsummizable tool falls back to its name", () => {
    expect(
      childActivityLabel(sub({ toolCalls: [{ name: "mcp__odd__thing", args: "" }] }), null),
    ).toBe("mcp__odd__thing");
  });
});

describe("row lines", () => {
  test("a subagent row carries tool, tokens and elapsed", () => {
    const child = sub({
      toolCalls: [{ name: "Bash", args: '{"command":"bun test bff"}' }],
      totalTokens: 48_000,
      durationMs: 364_000,
    });
    expect(subagentStatusLine("running", child, null)).toBe(
      "running · bun test bff · 48k tok · 6:04",
    );
  });

  test("tiny token counts stay out of the row", () => {
    expect(subagentStatusLine("running", sub(), null)).toBe("running · thinking");
  });

  test("a workflow row carries counts and phases", () => {
    expect(workflowStatusLine("running", workflow)).toBe(
      "running · 5/8 agents · 2 running · 1 failed · 140k tok",
    );
    expect(workflowPhasesLine(workflow)).toBe("plan 4/4 · build 1/4");
    expect(workflowPhasesLine({ ...workflow, phases: [] })).toBe("");
  });
});
