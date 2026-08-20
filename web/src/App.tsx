import { useEffect, useMemo, useRef, useState } from "react";
import { SessionClient, type LinkState } from "./lib/session-client.ts";
import type { BffHello, ConnectionState, SequencedFrame } from "./lib/protocol.ts";

interface Status {
  authenticated: boolean;
  auth_mode: "google" | "dev-bypass";
  user: { email: string; name: string } | null;
  upstream: { state: ConnectionState; info: unknown };
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [linkState, setLinkState] = useState<LinkState>("connecting");
  const [hello, setHello] = useState<BffHello | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [lastFrameType, setLastFrameType] = useState<string>("—");
  const clientRef = useRef<SessionClient | null>(null);

  useEffect(() => {
    void fetch("/api/status")
      .then((response) => response.json() as Promise<Status>)
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    if (!status?.authenticated) return;

    const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const client = new SessionClient(wsUrl, {
      onFrame: (frame: SequencedFrame) => {
        setFrameCount((count) => count + 1);
        setLastFrameType(String((frame as { type?: unknown }).type ?? "?"));
      },
      onStateChange: (link) => setLinkState(link),
      onResyncRequired: () => {
        // Phase 3 rebuilds the transcript from conversation_messages_list here.
      },
      onHello: setHello,
      onError: (error) => console.warn("[bff]", error.message),
    });

    clientRef.current = client;
    client.start();
    return () => {
      client.stop();
      clientRef.current = null;
    };
  }, [status?.authenticated]);

  const indicator = useMemo(() => {
    switch (linkState) {
      case "live":
        return { label: "Live", tone: "ok" as const };
      case "connecting":
        return { label: "Connecting…", tone: "warn" as const };
      case "reconnecting":
        return { label: "Reconnecting…", tone: "warn" as const };
      case "resyncing":
        return { label: "Resyncing…", tone: "warn" as const };
      case "offline":
        return { label: "Agent server offline", tone: "bad" as const };
    }
  }, [linkState]);

  if (status === null) {
    return <Shell><p className="muted">Loading…</p></Shell>;
  }

  if (!status.authenticated) {
    const bypass = status.auth_mode === "dev-bypass";
    return (
      <Shell>
        <h1>Letta</h1>
        {bypass ? (
          <>
            <p className="warning">
              Developer sign-in is enabled. This does <strong>not</strong> authenticate
              anyone — any visitor becomes the configured user. Unset
              <code> DEV_BYPASS_EMAIL</code> to require Google sign-in.
            </p>
            <a className="button" href="/auth/login">Continue without signing in</a>
          </>
        ) : (
          <>
            <p className="muted">Sign in to continue.</p>
            <a className="button" href="/auth/login">Sign in with Google</a>
          </>
        )}
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="topbar">
        <h1>Letta</h1>
        <span className={`pill ${indicator.tone}`}>{indicator.label}</span>
      </header>

      <section className="card">
        <h2>Connection</h2>
        <dl>
          <dt>User</dt>
          <dd>
            {status.user?.email ?? "—"}
            {status.auth_mode === "dev-bypass" ? " (dev bypass — not authenticated)" : ""}
          </dd>
          <dt>Session</dt>
          <dd>{hello?.session_id?.slice(0, 8) ?? "—"}</dd>
          <dt>App-server</dt>
          <dd>{hello?.upstream ?? status.upstream.state}</dd>
          <dt>Frames</dt>
          <dd>{frameCount} (last: {lastFrameType})</dd>
        </dl>
      </section>

      <p className="muted">
        Chat, Files, Tasks and Memory arrive in the next phases. The link above stays
        live across tab switches — backgrounding this tab does not interrupt the agent.
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="shell">{children}</main>;
}
