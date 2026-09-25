import { describe, expect, mock, test } from "bun:test";
import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { failureBody, PUSH_ERROR_EXCERPT_CHARS, TurnOutcomeWatcher } from "./turn-watcher.ts";

function turnFinishedFrame(scopeKey: string, error?: string): WsProtocolMessage {
  const [agentId, conversationId] = scopeKey.split("::");
  return {
    type: "turn_finished",
    turn_id: "turn-1",
    stop_reason: error ? "error" : "end_turn",
    runtime: { agent_id: agentId, conversation_id: conversationId },
    ...(error ? { error } : {}),
  } as unknown as WsProtocolMessage;
}

const fakeStore = {} as ConstructorParameters<typeof TurnOutcomeWatcher>[0];

/** Typed with four params so `.mock.calls[n]` indexes correctly — a
 * zero-param mock still satisfies the constructor's type, but bun infers the
 * calls tuple from the literal function's own arity, not the wider type. */
function fakeNotify() {
  return mock(async (_store: unknown, _payload: unknown, _eventType: unknown, _log: unknown) => {});
}

describe("TurnOutcomeWatcher", () => {
  const scope = "agent-1::conv-1";

  test("fires 'completed' on a successful turn_finished when nobody is watching", () => {
    const notify = fakeNotify();
    const watcher = new TurnOutcomeWatcher(fakeStore, () => {}, notify);

    watcher.observe(turnFinishedFrame(scope), () => false);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[2]).toBe("completed");
  });

  test("fires 'failed' when turn_finished carries an error", () => {
    const notify = fakeNotify();
    const watcher = new TurnOutcomeWatcher(fakeStore, () => {}, notify);

    watcher.observe(turnFinishedFrame(scope, "boom"), () => false);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[2]).toBe("failed");
  });

  test("the failure push names the error", () => {
    const notify = fakeNotify();
    const watcher = new TurnOutcomeWatcher(fakeStore, () => {}, notify);

    watcher.observe(
      turnFinishedFrame(scope, 'Conversation is still busy\n{"body":"raw"}'),
      () => false,
    );

    const payload = notify.mock.calls[0]?.[1] as { body?: string };
    expect(payload.body).toBe("Your agent hit an error: Conversation is still busy");
  });

  test("failureBody clips a long error and falls back when empty", () => {
    const long = failureBody("x".repeat(500));
    expect(long.length).toBe("Your agent hit an error: ".length + PUSH_ERROR_EXCERPT_CHARS);
    expect(long.endsWith("…")).toBe(true);
    expect(failureBody("  \n ")).toBe("Your agent hit an error.");
  });

  test("does not fire when a session is watching the scope", () => {
    const notify = fakeNotify();
    const watcher = new TurnOutcomeWatcher(fakeStore, () => {}, notify);

    watcher.observe(turnFinishedFrame(scope), () => true);

    expect(notify).not.toHaveBeenCalled();
  });

  test("ignores frames that are not turn_finished", () => {
    const notify = fakeNotify();
    const watcher = new TurnOutcomeWatcher(fakeStore, () => {}, notify);

    watcher.observe({ type: "update_device_status" } as unknown as WsProtocolMessage, () => false);

    expect(notify).not.toHaveBeenCalled();
  });

  test("does not fire without a resolvable scope", () => {
    const notify = fakeNotify();
    const watcher = new TurnOutcomeWatcher(fakeStore, () => {}, notify);

    watcher.observe(
      {
        type: "turn_finished",
        turn_id: "t",
        stop_reason: "end_turn",
      } as unknown as WsProtocolMessage,
      () => false,
    );

    expect(notify).not.toHaveBeenCalled();
  });

  test("the deep-link url carries the frame's agent and conversation id", () => {
    const notify = fakeNotify();
    const watcher = new TurnOutcomeWatcher(fakeStore, () => {}, notify);

    watcher.observe(turnFinishedFrame(scope), () => false);

    const payload = notify.mock.calls[0]?.[1] as { url?: string };
    expect(payload.url).toBe("/?agent=agent-1&conversation=conv-1");
  });
});
