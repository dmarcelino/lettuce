import { describe, expect, mock, test } from "bun:test";
import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { TurnCompletionWatcher } from "./turn-watcher.ts";

function deviceStatusFrame(scopeKey: string, isProcessing: boolean): WsProtocolMessage {
  const [agentId, conversationId] = scopeKey.split("::");
  return {
    type: "update_device_status",
    runtime: { agent_id: agentId, conversation_id: conversationId },
    device_status: { is_processing: isProcessing },
  } as unknown as WsProtocolMessage;
}

const fakeStore = {} as ConstructorParameters<typeof TurnCompletionWatcher>[0];

describe("TurnCompletionWatcher", () => {
  const scope = "agent-1::conv-1";

  test("fires on a true->false transition when nobody is watching", () => {
    const notify = mock(async () => {});
    const watcher = new TurnCompletionWatcher(fakeStore, () => {}, notify);

    watcher.observe(deviceStatusFrame(scope, true), () => false);
    watcher.observe(deviceStatusFrame(scope, false), () => false);

    expect(notify).toHaveBeenCalledTimes(1);
  });

  test("does not fire when a session is watching the scope", () => {
    const notify = mock(async () => {});
    const watcher = new TurnCompletionWatcher(fakeStore, () => {}, notify);

    watcher.observe(deviceStatusFrame(scope, true), () => true);
    watcher.observe(deviceStatusFrame(scope, false), () => true);

    expect(notify).not.toHaveBeenCalled();
  });

  test("the first observation for a scope only seeds state, never fires", () => {
    const notify = mock(async () => {});
    const watcher = new TurnCompletionWatcher(fakeStore, () => {}, notify);

    watcher.observe(deviceStatusFrame(scope, false), () => false);

    expect(notify).not.toHaveBeenCalled();
  });

  test("never fires on a false->false or true->true repeat", () => {
    const notify = mock(async () => {});
    const watcher = new TurnCompletionWatcher(fakeStore, () => {}, notify);

    watcher.observe(deviceStatusFrame(scope, true), () => false);
    watcher.observe(deviceStatusFrame(scope, true), () => false);
    watcher.observe(deviceStatusFrame(scope, false), () => false);
    watcher.observe(deviceStatusFrame(scope, false), () => false);

    expect(notify).toHaveBeenCalledTimes(1);
  });

  test("ignores frames that are not update_device_status", () => {
    const notify = mock(async () => {});
    const watcher = new TurnCompletionWatcher(fakeStore, () => {}, notify);

    watcher.observe(deviceStatusFrame(scope, true), () => false);
    watcher.observe({ type: "update_loop_status" } as unknown as WsProtocolMessage, () => false);
    watcher.observe(deviceStatusFrame(scope, false), () => false);

    expect(notify).toHaveBeenCalledTimes(1);
  });

  test("does not fire again while a turn stays paused on an approval (is_processing stays true)", () => {
    const notify = mock(async () => {});
    const watcher = new TurnCompletionWatcher(fakeStore, () => {}, notify);

    // is_processing stays true through WAITING_ON_APPROVAL — never a
    // true->false edge, so this must never fire.
    watcher.observe(deviceStatusFrame(scope, true), () => false);
    watcher.observe(deviceStatusFrame(scope, true), () => false);
    watcher.observe(deviceStatusFrame(scope, true), () => false);

    expect(notify).not.toHaveBeenCalled();
  });

  test("tracks scopes independently", () => {
    const notify = mock(async () => {});
    const watcher = new TurnCompletionWatcher(fakeStore, () => {}, notify);
    const otherScope = "agent-2::conv-2";

    watcher.observe(deviceStatusFrame(scope, true), () => false);
    watcher.observe(deviceStatusFrame(otherScope, true), () => false);
    watcher.observe(deviceStatusFrame(scope, false), () => false);

    expect(notify).toHaveBeenCalledTimes(1);
  });
});
