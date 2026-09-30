import { describe, expect, test } from "bun:test";
import { planForceSend, readQueue } from "./queue-actions.ts";

function item(id: string, content: string, extra: Partial<ReturnType<typeof base>> = {}) {
  return { ...base(id, content), ...extra };
}

function base(id: string, content: string) {
  return {
    id,
    content,
    raw: content,
    clientMessageId: `cm-${id}`,
    source: "user",
    paused: false,
  };
}

describe("readQueue", () => {
  test("parses a snapshot, keeping raw content and identity", () => {
    const parts = [
      { type: "text", text: "look" },
      { type: "image", url: "x" },
    ];
    const queue = readQueue([
      {
        id: "q1",
        content: parts,
        client_message_id: "cm-1",
        source: "user",
        paused: true,
      },
      { id: "q2", content: "plain", source: "cron" },
      { content: "no id" },
      null,
      "junk",
    ]);
    expect(queue).toHaveLength(2);
    expect(queue[0]).toEqual({
      id: "q1",
      content: "look",
      raw: parts,
      clientMessageId: "cm-1",
      source: "user",
      paused: true,
    });
    expect(queue[1]?.source).toBe("cron");
    expect(queue[1]?.paused).toBe(false);
  });

  test("falls back to JSON for content with no text parts", () => {
    const queue = readQueue([{ id: "q1", content: [{ type: "image", url: "x" }] }]);
    expect(queue[0]?.content).toContain("image");
  });

  test("non-array snapshots read as empty", () => {
    expect(readQueue(undefined)).toEqual([]);
    expect(readQueue({})).toEqual([]);
  });
});

describe("planForceSend", () => {
  test("target first, others keep relative order", () => {
    const queue = [item("a", "first"), item("b", "second"), item("c", "third")];
    const plan = planForceSend(queue, "c");
    expect(plan?.remove).toEqual(["a", "b", "c"]);
    expect(plan?.resend.map((r) => r.content)).toEqual(["third", "first", "second"]);
    expect(plan?.removed.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  test("system items are never removed or resent", () => {
    const queue = [
      item("a", "mine"),
      item("cron1", "cron prompt", { source: "cron" }),
      item("b", "also mine"),
    ];
    const plan = planForceSend(queue, "b");
    expect(plan?.remove).toEqual(["a", "b"]);
    expect(plan?.resend.map((r) => r.content)).toEqual(["also mine", "mine"]);
  });

  test("a lone target plans a single resend", () => {
    const plan = planForceSend([item("a", "only")], "a");
    expect(plan?.remove).toEqual(["a"]);
    expect(plan?.resend.map((r) => r.content)).toEqual(["only"]);
  });

  test("no-op for unknown ids and non-user targets", () => {
    const queue = [item("a", "mine"), item("s", "system", { source: "system" })];
    expect(planForceSend(queue, "missing")).toBeNull();
    expect(planForceSend(queue, "s")).toBeNull();
    expect(planForceSend([], "a")).toBeNull();
  });

  test("raw content rides through for faithful resends", () => {
    const parts = [
      { type: "text", text: "hi" },
      { type: "image", url: "x" },
    ];
    const queue = readQueue([{ id: "q1", content: parts, source: "user" }]);
    const plan = planForceSend(queue, "q1");
    expect(plan?.resend[0]?.raw).toBe(parts);
  });
});
