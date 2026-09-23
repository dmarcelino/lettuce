import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AppServerInfo,
  type ConnectionState,
  type RuntimeScope,
  type SequencedFrame,
  scopeKey,
} from "../lib/protocol.ts";
import { type LinkState, SessionClient } from "../lib/session-client.ts";

export interface SessionApi {
  link: LinkState;
  upstream: ConnectionState;
  ready: boolean;
  /** Capability-discovery handshake; null until the first hello or after a hard resync loss. */
  appServerInfo: AppServerInfo | null;
  request: <T = unknown>(type: string, body?: Record<string, unknown>) => Promise<T>;
  send: (command: Record<string, unknown> & { type: string }) => void;
  setScopes: (scopes: RuntimeScope[]) => void;
  markResynced: () => void;
  /** Subscribe to inbound app-server frames. Returns an unsubscribe function. */
  onFrame: (handler: (frame: SequencedFrame) => void) => () => void;
  /** Fires when the BFF buffer could not cover the gap and history must reload. */
  onResync: (handler: () => void) => () => void;
  /**
   * The latest BFF error no pending request claimed — a rate limit, a command
   * the browser allowlist refused, a fire-and-forget send that failed. Nothing
   * else surfaces these, so it stays set until `clearError`.
   */
  lastError: string | null;
  clearError: () => void;
  /**
   * Scope keys (`scopeKey`) of every conversation with a response in progress,
   * across all agents — not just the open one. Tracked by the BFF, which sees
   * every conversation (`bff/src/session/activity.ts`).
   */
  activeScopes: ReadonlySet<string>;
  /** Agents with at least one conversation in `activeScopes`. */
  activeAgentIds: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

export function useSession(enabled: boolean): SessionApi {
  const [link, setLink] = useState<LinkState>("connecting");
  const [upstream, setUpstream] = useState<ConnectionState>("connecting");
  const [appServerInfo, setAppServerInfo] = useState<AppServerInfo | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [active, setActive] = useState<RuntimeScope[]>([]);

  const clientRef = useRef<SessionClient | null>(null);
  const frameHandlers = useRef(new Set<(frame: SequencedFrame) => void>());
  const resyncHandlers = useRef(new Set<() => void>());

  useEffect(() => {
    if (!enabled) return;

    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const client = new SessionClient(url, {
      onFrame: (frame) => {
        for (const handler of frameHandlers.current) handler(frame);
      },
      onStateChange: (linkState, upstreamState) => {
        setLink(linkState);
        setUpstream(upstreamState);
      },
      onResyncRequired: () => {
        for (const handler of resyncHandlers.current) handler();
      },
      onHello: (hello) => setUpstream(hello.upstream),
      onAppServerInfo: (info) => setAppServerInfo(info),
      onError: (error) => setLastError(error.message),
      onActivity: (next) => setActive(next),
    });

    clientRef.current = client;
    client.start();
    return () => {
      client.stop();
      clientRef.current = null;
    };
  }, [enabled]);

  const request = useCallback(<T>(type: string, body: Record<string, unknown> = {}) => {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error("Not connected"));
    return client.request(type, body) as Promise<T>;
  }, []);

  const send = useCallback((command: Record<string, unknown> & { type: string }) => {
    clientRef.current?.send(command);
  }, []);

  const setScopes = useCallback((scopes: RuntimeScope[]) => {
    clientRef.current?.setScopes(scopes);
  }, []);

  const markResynced = useCallback(() => {
    clientRef.current?.markResynced();
  }, []);

  const onFrame = useCallback((handler: (frame: SequencedFrame) => void) => {
    frameHandlers.current.add(handler);
    return () => frameHandlers.current.delete(handler);
  }, []);

  const onResync = useCallback((handler: () => void) => {
    resyncHandlers.current.add(handler);
    return () => resyncHandlers.current.delete(handler);
  }, []);

  const clearError = useCallback(() => setLastError(null), []);

  // Stable identities while the set is unchanged, so consumers' memo deps hold.
  const activeScopes = useMemo(
    () => (active.length === 0 ? NONE : new Set(active.map(scopeKey))),
    [active],
  );
  const activeAgentIds = useMemo(
    () => (active.length === 0 ? NONE : new Set(active.map((scope) => scope.agent_id))),
    [active],
  );

  // Must be memoized. Every consumer derives useCallback/useEffect deps from
  // this object, so returning a fresh literal each render makes those effects
  // re-run on every render — which previously produced an unbounded request
  // loop against the app-server.
  return useMemo(
    () => ({
      link,
      upstream,
      ready: link === "live",
      appServerInfo,
      request,
      send,
      setScopes,
      markResynced,
      onFrame,
      onResync,
      lastError,
      clearError,
      activeScopes,
      activeAgentIds,
    }),
    [
      link,
      upstream,
      appServerInfo,
      request,
      send,
      setScopes,
      markResynced,
      onFrame,
      onResync,
      lastError,
      clearError,
      activeScopes,
      activeAgentIds,
    ],
  );
}
