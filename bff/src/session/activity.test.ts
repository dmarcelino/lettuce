import { describe, expect, test } from "bun:test";
import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { ActivityTracker } from "./activity.ts";

const scope = { agent_id: "agent-1", conversation_id: "conv-1" };

function status(isProcessing: boolean, runtime: unknown = scope): WsProtocolMessage {
  return {
    type: "update_device_status",
    runtime,
    device_status: { is_processing: isProcessing },
  } as unknown as WsProtocolMessage;
}

function finished(runtime: unknown = scope): WsProtocolMessage {
  return { type: "turn_finished", runtime, turn_id: "t", stop_reason: "end_turn" } as never;
}

describe("ActivityTracker", () => {
  test("a processing status marks the scope active, and reports the change once", () => {
    const tracker = new ActivityTracker();
    expect(tracker.observe(status(true))).toBe(true);
    expect(tracker.observe(status(true))).toBe(false);
    expect(tracker.snapshot()).toEqual([scope]);
  });

  test("an idle status or turn_finished clears it", () => {
    const tracker = new ActivityTracker();
    tracker.observe(status(true));
    expect(tracker.observe(status(false))).toBe(true);
    expect(tracker.snapshot()).toEqual([]);

    tracker.observe(status(true));
    expect(tracker.observe(finished())).toBe(true);
    expect(tracker.snapshot()).toEqual([]);
  });

  test("scopes are tracked independently", () => {
    const tracker = new ActivityTracker();
    const other = { agent_id: "agent-2", conversation_id: "conv-9" };
    tracker.observe(status(true));
    tracker.observe(status(true, other));
    tracker.observe(finished());
    expect(tracker.snapshot()).toEqual([other]);
  });

  test("unscoped and unrelated frames are ignored", () => {
    const tracker = new ActivityTracker();
    expect(tracker.observe(status(true, null))).toBe(false);
    expect(tracker.observe({ type: "update_queue", runtime: scope } as never)).toBe(false);
    expect(tracker.snapshot()).toEqual([]);
  });

  test("clear reports whether anything was dropped", () => {
    const tracker = new ActivityTracker();
    expect(tracker.clear()).toBe(false);
    tracker.observe(status(true));
    expect(tracker.clear()).toBe(true);
    expect(tracker.snapshot()).toEqual([]);
  });
});
