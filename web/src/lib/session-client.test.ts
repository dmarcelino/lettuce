import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AuthProbe } from "./auth-probe.ts";
import { type LinkState, SessionClient, type SessionClientEvents } from "./session-client.ts";

/** Just enough of a WebSocket to drive the client's lifecycle by hand. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send() {}
  close() {}
  /** The server refused or the network failed before the handshake. */
  fail(code = 1006) {
    this.onclose?.({ code });
  }
}

const saved = {
  WebSocket: globalThis.WebSocket,
  document: globalThis.document,
  window: globalThis.window,
};
const noop = () => {};
Object.assign(globalThis, {
  WebSocket: FakeSocket,
  document: { visibilityState: "visible", addEventListener: noop, removeEventListener: noop },
  window: { addEventListener: noop, removeEventListener: noop },
});
afterAll(() => Object.assign(globalThis, saved));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(probeResult: AuthProbe) {
  const states: LinkState[] = [];
  const onAuthExpired = mock(() => {});
  const probe = mock(async () => probeResult);
  const events = {
    onFrame: noop,
    onStateChange: (link: LinkState) => states.push(link),
    onResyncRequired: noop,
    onHello: noop,
    onAppServerInfo: noop,
    onError: noop,
    onActivity: noop,
    onAuthExpired,
  } satisfies SessionClientEvents;
  const client = new SessionClient("ws://test/ws", events, probe);
  client.start();
  return { client, states, onAuthExpired, probe, latest: () => FakeSocket.instances.at(-1)! };
}

beforeEach(() => {
  FakeSocket.instances = [];
});

describe("SessionClient sign-in expiry", () => {
  test("close code 4401 signs out at once, without probing or retrying", async () => {
    const { client, states, onAuthExpired, probe, latest } = setup("ok");
    latest().fail(4401);
    await tick();
    expect(states.at(-1)).toBe("signed-out");
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(probe).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
    client.stop();
  });

  test("one failed open just retries; the second asks why", async () => {
    const { client, probe, latest } = setup("unreachable");
    latest().fail();
    await tick();
    expect(probe).not.toHaveBeenCalled();
    // Retry fires on the backoff timer.
    await new Promise((resolve) => setTimeout(resolve, 350));
    latest().fail();
    await tick();
    expect(probe).toHaveBeenCalledTimes(1);
    client.stop();
  });

  test("a probe that finds the login expired signs out and stops retrying", async () => {
    const { client, states, onAuthExpired, latest } = setup("expired");
    latest().fail();
    await new Promise((resolve) => setTimeout(resolve, 350));
    latest().fail();
    await tick();
    expect(states.at(-1)).toBe("signed-out");
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    const sockets = FakeSocket.instances.length;
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(FakeSocket.instances).toHaveLength(sockets);
    client.stop();
  });

  test("a probe that finds the login fine keeps reconnecting", async () => {
    const { client, states, onAuthExpired, latest } = setup("ok");
    latest().fail();
    await new Promise((resolve) => setTimeout(resolve, 350));
    latest().fail();
    await tick();
    expect(onAuthExpired).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe("reconnecting");
    const sockets = FakeSocket.instances.length;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(FakeSocket.instances.length).toBeGreaterThan(sockets);
    client.stop();
  });
});
