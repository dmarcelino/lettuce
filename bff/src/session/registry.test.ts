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
  isInternalRequest: () => false,
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

/**
 * Activity must reach every session, not only those subscribed to the busy
 * conversation — the whole point is to show turns running elsewhere.
 */
describe("activity broadcast", () => {
  function recordingSocket() {
    const sent: { type: string; active?: unknown }[] = [];
    const socket: SessionSocket = { send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };
    return { socket, sent };
  }
  const busy = {
    type: "update_device_status",
    runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
    device_status: { is_processing: true },
  } as never;
  const active = [{ agent_id: "agent-1", conversation_id: "conv-1" }];

  test("a session subscribed elsewhere still hears about it, and late joiners get it in hello", () => {
    const registry = new SessionRegistry(fakeUpstream, 100, () => {});
    const early = recordingSocket();
    const id = registry.add(early.socket, { email: "someone@example.com" });
    registry.handleSessionMessage(
      id,
      JSON.stringify({
        type: "__bff_resume",
        from_seq: null,
        scopes: [{ agent_id: "agent-1", conversation_id: "conv-2" }],
      }),
    );

    registry.handleUpstreamFrame(busy);
    expect(early.sent.filter((m) => m.type === "__bff_activity").map((m) => m.active)).toEqual([
      active,
    ]);

    const late = recordingSocket();
    registry.add(late.socket, { email: "someone@example.com" });
    expect(late.sent.find((m) => m.type === "__bff_hello")?.active).toEqual(active);
  });

  test("an upstream drop clears the set", () => {
    const registry = new SessionRegistry(fakeUpstream, 100, () => {});
    const tab = recordingSocket();
    registry.add(tab.socket, { email: "someone@example.com" });
    registry.handleUpstreamFrame(busy);
    registry.broadcastUpstreamState("disconnected", null);
    expect(tab.sent.filter((m) => m.type === "__bff_activity").at(-1)?.active).toEqual([]);
  });
});

/**
 * A response to a request the BFF made itself is not a browser's response, and
 * it is not an unsolicited frame either. Without the internal-id check it fell
 * through to the broadcast path, so a `bff-download-*` `read_file_response`
 * carried whole file contents to every connected session — and into the replay
 * buffer, where a later reconnect replayed them again.
 */
describe("internal upstream responses", () => {
  function fileResponse(requestId: string) {
    return {
      type: "read_file_response",
      request_id: requestId,
      path: "/work/agent-1/secret.md",
      content: "TOP SECRET",
      success: true,
    } as never;
  }

  function setup(ids: string[]) {
    const upstream = {
      getState: () => "connected",
      getInfo: () => null,
      isReady: () => true,
      send: () => {},
      isInternalRequest: (id: string) => ids.includes(id),
    } as unknown as UpstreamConnection;
    const registry = new SessionRegistry(upstream, 100, () => {});
    const sent: Record<string, unknown>[] = [];
    const socket: SessionSocket = { send: (raw) => sent.push(JSON.parse(raw)), close: () => {} };
    registry.add(socket, { email: "someone@example.com" });
    return { registry, sent };
  }

  test("an internal response is neither relayed nor buffered", () => {
    const { registry, sent } = setup(["bff-download-abc"]);
    expect(sent.map((m) => m.type)).toEqual(["__bff_hello"]);

    registry.handleUpstreamFrame(fileResponse("bff-download-abc"));

    expect(sent.map((m) => m.type)).toEqual(["__bff_hello"]);
    expect(registry.latestSeq).toBe(0);
  });

  test("an orphaned response for a departed session still falls through", () => {
    const { registry, sent } = setup([]);
    registry.handleUpstreamFrame(fileResponse("web-1"));
    expect(sent).toHaveLength(2);
    expect(registry.latestSeq).toBe(1);
  });
});
