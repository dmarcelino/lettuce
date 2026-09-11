import { describe, expect, mock, test } from "bun:test";
import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { ApprovalWatcher } from "./approval-watcher.ts";

function controlRequestFrame(scopeKey: string, toolName = "Bash"): WsProtocolMessage {
  const [agentId, conversationId] = scopeKey.split("::");
  return {
    type: "control_request",
    request_id: "req-1",
    agent_id: agentId,
    conversation_id: conversationId,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      input: {},
      tool_call_id: "call-1",
      permission_suggestions: [],
      blocked_path: null,
    },
  } as unknown as WsProtocolMessage;
}

const fakeStore = {} as ConstructorParameters<typeof ApprovalWatcher>[0];

/** Typed with four params so `.mock.calls[n]` indexes correctly — a
 * zero-param mock still satisfies the constructor's type, but bun infers the
 * calls tuple from the literal function's own arity, not the wider type. */
function fakeNotify() {
  return mock(async (_store: unknown, _payload: unknown, _eventType: unknown, _log: unknown) => {});
}

describe("ApprovalWatcher", () => {
  const scope = "agent-1::conv-1";

  test("fires on a can_use_tool control_request when nobody is watching", () => {
    const notify = fakeNotify();
    const watcher = new ApprovalWatcher(fakeStore, () => {}, notify);

    watcher.observe(controlRequestFrame(scope, "Bash"), () => false);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[2]).toBe("approval");
    const payload = notify.mock.calls[0]?.[1] as { body?: string; url?: string };
    expect(payload.body).toContain("Bash");
    expect(payload.url).toBe("/?agent=agent-1&conversation=conv-1");
  });

  test("does not fire when a session is watching the scope", () => {
    const notify = fakeNotify();
    const watcher = new ApprovalWatcher(fakeStore, () => {}, notify);

    watcher.observe(controlRequestFrame(scope), () => true);

    expect(notify).not.toHaveBeenCalled();
  });

  test("ignores frames that are not control_request", () => {
    const notify = fakeNotify();
    const watcher = new ApprovalWatcher(fakeStore, () => {}, notify);

    watcher.observe({ type: "turn_finished" } as unknown as WsProtocolMessage, () => false);

    expect(notify).not.toHaveBeenCalled();
  });

  test("ignores control_request subtypes other than can_use_tool", () => {
    const notify = fakeNotify();
    const watcher = new ApprovalWatcher(fakeStore, () => {}, notify);

    watcher.observe(
      {
        type: "control_request",
        request_id: "req-1",
        agent_id: "agent-1",
        conversation_id: "conv-1",
        request: { subtype: "other" },
      } as unknown as WsProtocolMessage,
      () => false,
    );

    expect(notify).not.toHaveBeenCalled();
  });

  test("does not fire without a resolvable scope", () => {
    const notify = fakeNotify();
    const watcher = new ApprovalWatcher(fakeStore, () => {}, notify);

    watcher.observe(
      {
        type: "control_request",
        request_id: "req-1",
        request: { subtype: "can_use_tool", tool_name: "Bash" },
      } as unknown as WsProtocolMessage,
      () => false,
    );

    expect(notify).not.toHaveBeenCalled();
  });
});
