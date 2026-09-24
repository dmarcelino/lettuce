import { describe, expect, test } from "bun:test";
import { FrameBuffer, frameScopeKey, parseScopeKey, scopeKeyOf } from "./buffer.ts";

/**
 * The buffer is the resume mechanism: get eviction or the resync boundary wrong
 * and a reconnecting tab either silently misses frames or reloads constantly.
 * These pin the semantics the previous array-and-splice implementation had, so
 * the ring rewrite cannot shift them.
 */
function fill(capacity: number, count: number, scope?: string) {
  const buffer = new FrameBuffer(capacity);
  for (let i = 0; i < count; i += 1) {
    buffer.append({ type: "x", n: i } as never, scope ?? null);
  }
  return buffer;
}

const seqs = (result: { frames: { seq: number }[] }) => result.frames.map((f) => f.seq);

describe("FrameBuffer sequencing", () => {
  test("latestSeq counts every append, even after eviction", () => {
    const buffer = fill(3, 10);
    expect(buffer.latestSeq).toBe(10);
    expect(buffer.size).toBe(3);
  });

  test("an empty buffer reports zero", () => {
    const buffer = new FrameBuffer(5);
    expect(buffer.latestSeq).toBe(0);
    expect(buffer.size).toBe(0);
  });
});

describe("FrameBuffer replay", () => {
  test("fromSeq null is a cold start with no resync", () => {
    const buffer = fill(5, 3);
    expect(buffer.replayFrom(null)).toEqual({
      frames: [],
      resyncRequired: false,
      latestSeq: 3,
    });
  });

  test("replays everything after fromSeq", () => {
    const buffer = fill(10, 5);
    expect(seqs(buffer.replayFrom(2))).toEqual([3, 4, 5]);
  });

  test("fromSeq 0 replays from the beginning", () => {
    const buffer = fill(10, 3);
    expect(seqs(buffer.replayFrom(0))).toEqual([1, 2, 3]);
  });

  test("a client ahead of the buffer needs a resync", () => {
    const buffer = fill(10, 3);
    expect(buffer.replayFrom(4)).toEqual({
      frames: [],
      resyncRequired: true,
      latestSeq: 3,
    });
  });

  test("a gap older than the retained window needs a resync", () => {
    const buffer = fill(3, 6); // retained: 4,5,6
    expect(buffer.replayFrom(2).resyncRequired).toBe(true);
  });

  test("exactly at the eviction boundary replays what is retained, no resync", () => {
    const buffer = fill(3, 6); // retained 4,5,6; oldestSeq 4; boundary is 3
    const result = buffer.replayFrom(3);
    expect(result.resyncRequired).toBe(false);
    expect(seqs(result)).toEqual([4, 5, 6]);
  });

  test("eviction keeps the newest frames and drops the oldest", () => {
    const buffer = fill(3, 10); // retained: 8, 9, 10
    expect(seqs(buffer.replayFrom(7))).toEqual([8, 9, 10]);
    // Asking for anything older than the boundary is a resync, not a partial.
    expect(buffer.replayFrom(6).resyncRequired).toBe(true);
  });

  test("capacity 1 still works", () => {
    const buffer = fill(1, 5);
    expect(buffer.size).toBe(1);
    expect(seqs(buffer.replayFrom(4))).toEqual([5]);
    expect(buffer.replayFrom(3).resyncRequired).toBe(true);
  });
});

describe("FrameBuffer scope filtering", () => {
  test("a scope filter keeps that scope and the unscoped frames", () => {
    const buffer = new FrameBuffer(10);
    buffer.append({ type: "x" } as never, null);
    buffer.append({ type: "x" } as never, "agent-1::conv-1");
    buffer.append({ type: "x" } as never, "agent-1::conv-2");
    buffer.append({ type: "x" } as never, "agent-1::conv-1");

    const scoped = buffer.replayFrom(0, new Set(["agent-1::conv-1"]));
    // seq 1 is unscoped (connection-wide) and must survive a scope filter;
    // seq 3 belongs to another scope and must not.
    expect(scoped.frames.map((f) => [f.seq, f.scopeKey])).toEqual([
      [1, null],
      [2, "agent-1::conv-1"],
      [4, "agent-1::conv-1"],
    ]);
  });

  test("no filter returns everything", () => {
    const buffer = new FrameBuffer(10);
    buffer.append({ type: "x" } as never, null);
    buffer.append({ type: "x" } as never, "agent-1::conv-1");
    expect(buffer.replayFrom(0).frames).toHaveLength(2);
  });
});

describe("scope key helpers", () => {
  test("scopeKeyOf round-trips through parseScopeKey", () => {
    expect(parseScopeKey(scopeKeyOf("a", "c"))).toEqual(["a", "c"]);
  });

  test("frameScopeKey reads the runtime envelope", () => {
    expect(frameScopeKey({ runtime: { agent_id: "a", conversation_id: "c" } } as never)).toBe(
      "a::c",
    );
  });

  test("frameScopeKey falls back to flat fields", () => {
    expect(frameScopeKey({ agent_id: "a", conversation_id: "c" } as never)).toBe("a::c");
  });

  test("an unscoped frame has no key", () => {
    expect(frameScopeKey({ type: "hello" } as never)).toBeNull();
  });
});
