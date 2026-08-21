import type { AppServerInfoResponseMessage } from "@letta-ai/letta-code/app-server-client";
import { AppServerClient } from "@letta-ai/letta-code/app-server-client";
import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import WebSocket from "ws";

export type UpstreamState = "connecting" | "connected" | "disconnected";

export interface UpstreamOptions {
  url: string;
  /** Empty when the app-server runs without `--ws-auth`. */
  authToken: string;
  onFrame: (frame: WsProtocolMessage) => void;
  onStateChange: (state: UpstreamState, info: AppServerInfoResponseMessage | null) => void;
  log?: (message: string) => void;
}

const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 15_000;

/**
 * The single, permanent connection to the app-server.
 *
 * THIS CONNECTION MUST NEVER BE CLOSED WHILE THE PROCESS IS ALIVE.
 *
 * The app-server ties turn ownership, queue entries, pending approvals and
 * terminals to the connection that created them. When a connection closes,
 * `cleanupListenerConnection` (letta-code: src/websocket/listener/connection-lifecycle.ts)
 * cancels the in-flight turn for every conversation it owned unless another
 * subscribed connection remains, drops its queued messages, and rejects its
 * pending approvals.
 *
 * Browser sessions therefore multiplex over this one connection rather than
 * holding their own. A phone backgrounding a tab drops only its browser-facing
 * socket; the app-server never observes a disconnect, so the agent keeps working.
 */
export class UpstreamConnection {
  private client: AppServerClient | null = null;
  private state: UpstreamState = "connecting";
  private info: AppServerInfoResponseMessage | null = null;
  private retryMs = INITIAL_RETRY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Times the upstream socket has been established. Must stay 1 in a healthy run. */
  private generation = 0;
  /** Scopes this connection has touched; re-subscribed after a reconnect. */
  private readonly knownScopes = new Map<string, { agent_id: string; conversation_id: string }>();

  constructor(private readonly options: UpstreamOptions) {}

  getState(): UpstreamState {
    return this.state;
  }

  getInfo(): AppServerInfoResponseMessage | null {
    return this.info;
  }

  /**
   * How many times we have connected upstream. A browser disconnect must never
   * increment this — see the class comment.
   */
  getGeneration(): number {
    return this.generation;
  }

  isReady(): boolean {
    return this.state === "connected" && this.client !== null;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Only for process shutdown. Never call this in response to a browser event. */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.client?.close();
    this.client = null;
    this.setState("disconnected");
  }

  /**
   * Forward a command upstream. The caller owns `request_id` allocation — see
   * SessionRegistry, which rewrites browser-supplied ids into BFF-owned ones.
   */
  send(command: Record<string, unknown> & { type: string }): void {
    if (!this.client || this.state !== "connected") {
      throw new Error("App-server connection is not ready");
    }
    this.rememberScope(command);
    this.client.sendRaw(command);
  }

  /** A BFF-internal request/response round trip (not on behalf of a session). */
  async request<T extends WsProtocolMessage>(
    command: Record<string, unknown> & { type: string; request_id: string },
    timeoutMs = 30_000,
  ): Promise<T> {
    if (!this.client || this.state !== "connected") {
      throw new Error("App-server connection is not ready");
    }
    this.rememberScope(command);
    return (await this.client.requestRaw(command, {
      timeoutMs,
      predicate: (message): message is never =>
        Boolean(
          message &&
            typeof message === "object" &&
            (message as { request_id?: unknown }).request_id === command.request_id,
        ),
    })) as unknown as T;
  }

  private rememberScope(command: Record<string, unknown>): void {
    const runtime = command.runtime;
    if (!runtime || typeof runtime !== "object") return;
    const scope = runtime as { agent_id?: unknown; conversation_id?: unknown };
    if (typeof scope.agent_id !== "string" || typeof scope.conversation_id !== "string") {
      return;
    }
    this.knownScopes.set(`${scope.agent_id}::${scope.conversation_id}`, {
      agent_id: scope.agent_id,
      conversation_id: scope.conversation_id,
    });
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private setState(state: UpstreamState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange(state, this.info);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState("connecting");

    let client: AppServerClient;
    try {
      client = new AppServerClient({
        url: this.options.url,
        // An empty token must be omitted entirely: the client rejects a blank
        // string, and an unauthenticated app-server wants no header at all.
        ...(this.options.authToken ? { authToken: this.options.authToken } : {}),
        // `ws` supports the Authorization header a browser cannot set. This is
        // the reason the BFF exists at all (see CLAUDE.md).
        WebSocket: WebSocket as never,
      });
    } catch (error) {
      this.log(`Upstream construction failed: ${errorMessage(error)}`);
      this.scheduleRetry();
      return;
    }

    this.client = client;
    client.onMessage((message) => this.options.onFrame(message));
    client.onDisconnect(() => {
      this.log("Upstream connection closed; reconnecting");
      this.client = null;
      this.setState("disconnected");
      this.scheduleRetry();
    });

    void client
      .connect()
      .then(async () => {
        this.retryMs = INITIAL_RETRY_MS;
        this.generation += 1;
        this.info = await client.info();
        this.setState("connected");
        this.log(
          `Upstream connected: letta-code ${this.info.letta_code_version}, ` +
            `backend=${this.info.backend}, protocol=${this.info.protocol_version}`,
        );
        // Re-subscribe to every scope we owned before the drop, so the
        // app-server routes their events back to us.
        await this.resubscribe();
      })
      .catch((error) => {
        this.log(`Upstream connect failed: ${errorMessage(error)}`);
        this.client = null;
        this.setState("disconnected");
        this.scheduleRetry();
      });
  }

  /**
   * A `sync` command carrying a runtime scope re-subscribes this connection to
   * that scope (letta-code: listener/message-router.ts subscribes on any scoped
   * command) and replays the listener's in-memory state for it.
   */
  private async resubscribe(): Promise<void> {
    for (const scope of this.knownScopes.values()) {
      try {
        await this.request({
          type: "sync",
          request_id: `bff-resync-${scope.agent_id}-${scope.conversation_id}-${Date.now()}`,
          runtime: scope,
          recover_approvals: true,
          force_device_status: true,
        });
      } catch (error) {
        this.log(
          `Re-subscribe failed for ${scope.agent_id}/${scope.conversation_id}: ${errorMessage(error)}`,
        );
      }
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
