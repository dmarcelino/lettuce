import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import {
  type BffError,
  type BffHello,
  type ConnectionState,
  frameSeq,
  isBffControlFrame,
  type RuntimeScope,
  type SequencedFrame,
} from "./protocol.ts";

export type LinkState = "connecting" | "live" | "reconnecting" | "resyncing" | "offline";

export interface SessionClientEvents {
  /** An app-server frame, already de-duplicated and in sequence order. */
  onFrame: (frame: SequencedFrame) => void;
  /** Link or upstream state changed; drives the connection indicator. */
  onStateChange: (link: LinkState, upstream: ConnectionState) => void;
  /** The buffer could not cover the gap — rebuild from conversation history. */
  onResyncRequired: () => void;
  onHello: (hello: BffHello) => void;
  onError: (error: BffError) => void;
}

interface PendingRequest {
  resolve: (message: WsProtocolMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const RECONNECT_BASE_MS = 300;
const RECONNECT_MAX_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * How long a single connection attempt gets before it's abandoned and retried.
 *
 * Everything else here is event-driven — `scheduleReconnect` only runs from
 * inside `onclose`. A handshake that hangs (routine right after a laptop
 * wakes from sleep or switches networks: the old route is gone, but nothing
 * tells the browser that) never fires `onopen`, `onerror`, or `onclose` on
 * some platforms, so without this the link sits on "Reconnecting…" forever —
 * the exact bug this timeout exists to close. A page reload "fixes" it only
 * because it discards the whole hung socket and starts over; this makes the
 * client do that to itself.
 */
const CONNECT_TIMEOUT_MS = 8_000;

/**
 * Browser-side connection to the BFF.
 *
 * Designed around the fact that a mobile browser drops its WebSocket whenever
 * the tab is backgrounded. Losing the socket is routine, not an error: the
 * agent keeps working on the server, and on return we replay exactly the frames
 * we missed using the sequence numbers the BFF assigns.
 */
export class SessionClient {
  private socket: WebSocket | null = null;
  private linkState: LinkState = "connecting";
  private upstreamState: ConnectionState = "connecting";
  private lastSeq: number | null = null;
  private reconnectMs = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private requestCounter = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private scopes: RuntimeScope[] = [];

  constructor(
    private readonly url: string,
    private readonly events: SessionClientEvents,
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("online", this.handleOnline);
    // `visibilitychange` covers a backgrounded tab; it does not fire when the
    // whole machine sleeps while this tab stayed the foreground one — the
    // page's own visibility never changed, so nothing about waking up looks
    // different to the DOM. `focus` reliably fires when the window becomes
    // active again either way, so it catches that gap too. Reuses the same
    // handler: it already no-ops when the socket is open.
    window.addEventListener("focus", this.handleOnline);
  }

  stop(): void {
    this.closed = true;
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("focus", this.handleOnline);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  getLinkState(): LinkState {
    return this.linkState;
  }

  /** Narrow replay to the conversations currently on screen. */
  setScopes(scopes: RuntimeScope[]): void {
    this.scopes = scopes;
  }

  /**
   * Called after the app rebuilds from `conversation_messages_list`, so the
   * next resume starts from the live head instead of asking for a replay the
   * buffer can no longer serve.
   */
  markResynced(latestSeq: number): void {
    this.lastSeq = latestSeq;
  }

  send(command: Record<string, unknown> & { type: string }): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }
    this.socket.send(JSON.stringify(command));
  }

  request<T extends WsProtocolMessage = WsProtocolMessage>(
    type: string,
    body: Record<string, unknown> = {},
  ): Promise<T> {
    this.requestCounter += 1;
    const requestId = `web-${this.requestCounter}`;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timed out waiting for ${type}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(requestId, {
        resolve: (message) => resolve(message as T),
        reject,
        timeout,
      });

      try {
        this.send({ ...body, type, request_id: requestId });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleVisibilityChange = (): void => {
    // Coming back to the foreground is the single most common moment for the
    // socket to be silently dead. Reconnect immediately rather than waiting for
    // a close event that may never arrive.
    if (document.visibilityState !== "visible" || this.closed) return;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.reconnectMs = RECONNECT_BASE_MS;
    this.connectNow();
  };

  private handleOnline = (): void => {
    if (this.closed || this.socket?.readyState === WebSocket.OPEN) return;
    this.reconnectMs = RECONNECT_BASE_MS;
    this.connectNow();
  };

  private setLinkState(state: LinkState): void {
    if (this.linkState === state) return;
    this.linkState = state;
    this.events.onStateChange(state, this.upstreamState);
  }

  private connectNow(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;

    // A stale attempt can still be outstanding here: `focus`, `online`, and
    // `visibilitychange` can each independently ask for a fresh connection in
    // quick succession (e.g. a window regaining focus while the network also
    // just came back). Detach and close it first — otherwise its `onopen`
    // could still fire later against a socket `this.socket` no longer points
    // to, sending a second `__bff_resume` the rest of this class never sees.
    if (this.socket && this.socket.readyState !== WebSocket.OPEN) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.close();
    }

    this.setLinkState(this.lastSeq === null ? "connecting" : "reconnecting");

    const socket = new WebSocket(this.url);
    this.socket = socket;

    // A hung handshake never reaches `onopen`, so nothing here would ever call
    // `onclose` to schedule a retry — this is that fallback. `close()` on a
    // still-CONNECTING socket is well-defined: it aborts the connection and
    // fires `onclose`, which routes into the ordinary retry path below.
    const connectTimeout = setTimeout(() => {
      if (this.socket !== socket) return;
      socket.close();
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      clearTimeout(connectTimeout);
      this.reconnectMs = RECONNECT_BASE_MS;
      // Ask for everything we missed while the tab was away.
      socket.send(
        JSON.stringify({
          type: "__bff_resume",
          from_seq: this.lastSeq,
          scopes: this.scopes,
        }),
      );
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      this.handleFrame(parsed);
    };

    socket.onclose = () => {
      clearTimeout(connectTimeout);
      if (this.socket === socket) this.socket = null;
      this.rejectAllPending("Connection lost");
      if (this.closed) return;
      this.setLinkState("reconnecting");
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // `close` always follows; handled there.
    };
  }

  private handleFrame(raw: unknown): void {
    if (isBffControlFrame(raw)) {
      switch (raw.type) {
        case "__bff_hello":
          this.upstreamState = raw.upstream;
          this.events.onHello(raw);
          return;

        case "__bff_resume_result": {
          const result = raw;
          if (result.resync_required) {
            this.setLinkState("resyncing");
            this.lastSeq = result.latest_seq;
            this.events.onResyncRequired();
          } else {
            this.setLinkState("live");
          }
          return;
        }

        case "__bff_upstream_state":
          this.upstreamState = raw.state;
          this.setLinkState(raw.state === "connected" ? "live" : "offline");
          return;

        case "__bff_error": {
          const error = raw;
          if (error.request_id) {
            const pending = this.pending.get(error.request_id);
            if (pending) {
              clearTimeout(pending.timeout);
              this.pending.delete(error.request_id);
              pending.reject(new Error(error.message));
              return;
            }
          }
          this.events.onError(error);
          return;
        }
      }
    }

    const frame = raw as SequencedFrame;
    const seq = frameSeq(frame);
    if (seq !== null) {
      // Replayed frames arrive in order; ignore anything we already rendered so
      // an overlapping replay cannot duplicate output.
      if (this.lastSeq !== null && seq <= this.lastSeq) return;
      this.lastSeq = seq;
      if (this.linkState !== "live") this.setLinkState("live");
    }

    const requestId = (frame as { request_id?: unknown }).request_id;
    if (typeof requestId === "string") {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(requestId);
        pending.resolve(frame);
        return;
      }
    }

    this.events.onFrame(frame);
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.reject(new Error(reason));
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
