import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionState, RuntimeScope, SequencedFrame } from "../lib/protocol.ts";
import { SessionClient, type LinkState } from "../lib/session-client.ts";

export interface SessionApi {
  link: LinkState;
  upstream: ConnectionState;
  ready: boolean;
  request: <T = unknown>(type: string, body?: Record<string, unknown>) => Promise<T>;
  send: (command: Record<string, unknown> & { type: string }) => void;
  setScopes: (scopes: RuntimeScope[]) => void;
  markResynced: (seq: number) => void;
  /** Subscribe to inbound app-server frames. Returns an unsubscribe function. */
  onFrame: (handler: (frame: SequencedFrame) => void) => () => void;
  /** Fires when the BFF buffer could not cover the gap and history must reload. */
  onResync: (handler: () => void) => () => void;
  lastError: string | null;
}

export function useSession(enabled: boolean): SessionApi {
  const [link, setLink] = useState<LinkState>("connecting");
  const [upstream, setUpstream] = useState<ConnectionState>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);

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
      onError: (error) => setLastError(error.message),
    });

    clientRef.current = client;
    client.start();
    return () => {
      client.stop();
      clientRef.current = null;
    };
  }, [enabled]);

  const request = useCallback(<T,>(type: string, body: Record<string, unknown> = {}) => {
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

  const markResynced = useCallback((seq: number) => {
    clientRef.current?.markResynced(seq);
  }, []);

  const onFrame = useCallback((handler: (frame: SequencedFrame) => void) => {
    frameHandlers.current.add(handler);
    return () => frameHandlers.current.delete(handler);
  }, []);

  const onResync = useCallback((handler: () => void) => {
    resyncHandlers.current.add(handler);
    return () => resyncHandlers.current.delete(handler);
  }, []);

  // Must be memoized. Every consumer derives useCallback/useEffect deps from
  // this object, so returning a fresh literal each render makes those effects
  // re-run on every render — which previously produced an unbounded request
  // loop against the app-server.
  return useMemo(
    () => ({
      link,
      upstream,
      ready: link === "live",
      request,
      send,
      setScopes,
      markResynced,
      onFrame,
      onResync,
      lastError,
    }),
    [link, upstream, request, send, setScopes, markResynced, onFrame, onResync, lastError],
  );
}
