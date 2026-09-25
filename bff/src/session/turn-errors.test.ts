import { describe, expect, test } from "bun:test";
import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { scopeKeyOf } from "./buffer.ts";
import { TURN_ERROR_SCOPES, TURN_ERRORS_PER_SCOPE, TurnErrorLog } from "./turn-errors.ts";

function finished(conversationId: string, turnId: string, error?: string): WsProtocolMessage {
  return {
    type: "turn_finished",
    turn_id: turnId,
    stop_reason: error ? "error" : "end_turn",
    run_id: `run-${turnId}`,
    runtime: { agent_id: "agent-1", conversation_id: conversationId },
    ...(error ? { error } : {}),
  } as unknown as WsProtocolMessage;
}

const key = scopeKeyOf("agent-1", "conv-1");

describe("TurnErrorLog", () => {
  test("records a failed turn with its run, reason and time", () => {
    const log = new TurnErrorLog(() => new Date("2026-09-25T16:38:42.803Z"));
    log.observe(finished("conv-1", "t1", "Conversation is still busy"));

    expect(log.list(key)).toEqual([
      {
        turn_id: "t1",
        run_id: "run-t1",
        stop_reason: "error",
        error: "Conversation is still busy",
        at: "2026-09-25T16:38:42.803Z",
      },
    ]);
  });

  test("ignores successful turns and other frames", () => {
    const log = new TurnErrorLog();
    log.observe(finished("conv-1", "t1"));
    log.observe({ type: "update_device_status" } as unknown as WsProtocolMessage);
    expect(log.list(key)).toEqual([]);
  });

  test("keeps only the most recent errors per conversation", () => {
    const log = new TurnErrorLog();
    for (let i = 0; i < TURN_ERRORS_PER_SCOPE + 3; i++)
      log.observe(finished("conv-1", `t${i}`, "x"));
    const kept = log.list(key);
    expect(kept).toHaveLength(TURN_ERRORS_PER_SCOPE);
    expect(kept[0]?.turn_id).toBe("t3");
  });

  test("evicts the least recently failed conversation first", () => {
    const log = new TurnErrorLog();
    log.observe(finished("conv-1", "t", "x"));
    for (let i = 0; i < TURN_ERROR_SCOPES; i++) log.observe(finished(`other-${i}`, "t", "x"));
    expect(log.list(key)).toEqual([]);
    expect(log.list(scopeKeyOf("agent-1", "other-0"))).toHaveLength(1);
  });
});
