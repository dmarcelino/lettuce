import { describe, expect, test } from "bun:test";
import type { UpstreamConnection } from "../upstream/connection.ts";
import { SessionRegistry, type SessionSocket } from "./registry.ts";

/**
 * `isScopeWatched` decides whether a push is sent or silently dropped, so these
 * pin down the one thing that must be true: only a *visible* session with the
 * conversation on screen suppresses a notification.
 *
 * It used to ask whether any session was merely subscribed. A backgrounded
 * desktop tab keeps its WebSocket open for hours, so one open tab suppressed
 * every push on every device — the bug these exist to keep fixed.
 */
const fakeUpstream = {
  getState: () => "connected",
  getInfo: () => null,
  isReady: () => true,
  send: () => {},
} as unknown as UpstreamConnection;

function setup() {
  const registry = new SessionRegistry(fakeUpstream, 100, () => {});
  const socket: SessionSocket = { send: () => {}, close: () => {} };
  const open = () => registry.add(socket, { email: "someone@example.com" });
  const watch = (id: string, visible: boolean, scope: { a: string; c: string } | null) =>
    registry.handleSessionMessage(
      id,
      JSON.stringify({
        type: "__bff_watching",
        visible,
        scope: scope ? { agent_id: scope.a, conversation_id: scope.c } : null,
      }),
    );
  return { registry, open, watch };
}

const SCOPE = "agent-1::conv-1";
const here = { a: "agent-1", c: "conv-1" };
const elsewhere = { a: "agent-1", c: "conv-2" };

describe("isScopeWatched", () => {
  test("a visible session with the conversation on screen is watching", () => {
    const { registry, open, watch } = setup();
    watch(open(), true, here);
    expect(registry.isScopeWatched(SCOPE)).toBe(true);
  });

  test("a hidden tab is not watching, even though its socket is still open", () => {
    const { registry, open, watch } = setup();
    watch(open(), false, here);
    expect(registry.isScopeWatched(SCOPE)).toBe(false);
  });

  test("a visible session on another conversation is not watching this one", () => {
    const { registry, open, watch } = setup();
    watch(open(), true, elsewhere);
    expect(registry.isScopeWatched(SCOPE)).toBe(false);
  });

  test("a session that never reported watches nothing", () => {
    const { registry, open } = setup();
    open();
    expect(registry.isScopeWatched(SCOPE)).toBe(false);
  });

  test("one visible session is enough, among hidden ones", () => {
    const { registry, open, watch } = setup();
    watch(open(), false, here);
    watch(open(), true, here);
    expect(registry.isScopeWatched(SCOPE)).toBe(true);
  });

  test("issuing scoped commands does not by itself count as watching", () => {
    // `session.scopes` still grows for replay and fan-out; push suppression
    // deliberately no longer rides on it.
    const { registry, open } = setup();
    const id = open();
    registry.handleSessionMessage(
      id,
      JSON.stringify({
        type: "conversation_messages_list",
        runtime: { agent_id: here.a, conversation_id: here.c },
      }),
    );
    expect(registry.isScopeWatched(SCOPE)).toBe(false);
  });

  test("a closed session stops watching", () => {
    const { registry, open, watch } = setup();
    const id = open();
    watch(id, true, here);
    registry.remove(id);
    expect(registry.isScopeWatched(SCOPE)).toBe(false);
  });
});
