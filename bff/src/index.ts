import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { isAllowedUser, loadConfig, type BffConfig } from "./config.ts";
import {
  buildAuthorizationUrl,
  createOAuthState,
  deriveCodeVerifier,
  exchangeCode,
  fetchProfile,
  OAUTH_STATE_COOKIE,
} from "./auth/google.ts";
import {
  buildSessionCookie,
  clearSessionCookie,
  decodeSession,
  encodeSession,
  readCookie,
  SESSION_COOKIE,
  type SessionPayload,
} from "./auth/session-cookie.ts";
import { SessionRegistry, type SessionUser } from "./session/registry.ts";
import { UpstreamConnection } from "./upstream/connection.ts";

const config: BffConfig = loadConfig();
const secureCookies = config.publicOrigin.startsWith("https://");
const redirectUri = `${config.publicOrigin}/auth/google/callback`;

function log(message: string): void {
  console.log(`[bff] ${new Date().toISOString()} ${message}`);
}

// ── The one permanent upstream connection ────────────────────────────────────
// Opened here at boot, before any browser exists, and never closed. This is
// also what starts the app-server's process services (cron scheduler, Telegram
// adapters), which only boot on first client attach.
const upstream = new UpstreamConnection({
  url: config.appServerUrl,
  authToken: config.appServerToken,
  onFrame: (frame: WsProtocolMessage) => registry.handleUpstreamFrame(frame),
  onStateChange: (state, info) => {
    log(`Upstream state: ${state}`);
    registry.broadcastUpstreamState(state, info);
  },
  log,
});

const registry = new SessionRegistry(upstream, config.frameBufferSize, log);

upstream.start();

// ── HTTP ─────────────────────────────────────────────────────────────────────
const app = new Hono();

app.get("/healthz", (c) => c.text("ok\n"));

app.get("/readyz", (c) =>
  upstream.isReady()
    ? c.text("ok\n")
    : c.text(`app-server ${upstream.getState()}\n`, 503),
);

app.get("/api/status", (c) => {
  const session = currentSession(c.req.raw);
  return c.json({
    authenticated: session !== null,
    user: session ? { email: session.email, name: session.name } : null,
    upstream: {
      state: upstream.getState(),
      info: upstream.getInfo(),
      generation: upstream.getGeneration(),
    },
    sessions: registry.sessionCount,
    latest_seq: registry.latestSeq,
  });
});

app.get("/auth/login", async (c) => {
  if (config.devBypassEmail) {
    return c.redirect("/auth/dev-login");
  }
  const state = createOAuthState();
  const verifier = deriveCodeVerifier(state, config.sessionSecret);
  const url = await buildAuthorizationUrl({
    clientId: config.googleClientId,
    redirectUri,
    state,
    verifier,
  });
  c.header(
    "set-cookie",
    `${OAUTH_STATE_COOKIE}=${state}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600${secureCookies ? "; Secure" : ""}`,
  );
  return c.redirect(url);
});

app.get("/auth/dev-login", (c) => {
  const email = config.devBypassEmail;
  if (!email) return c.text("Dev login is disabled", 404);

  const allowed = isAllowedUser(config, email);
  if (!allowed) return c.text(`DEV_BYPASS_EMAIL ${email} is not in the allowlist`, 403);

  log(`Dev login as ${email}`);
  return issueSession(c.res, allowed.name ?? email, email);
});

app.get("/auth/google/callback", async (c) => {
  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = readCookie(c.req.header("cookie") ?? null, OAUTH_STATE_COOKIE);

  if (!code || !state || !expectedState || state !== expectedState) {
    return c.text("Invalid OAuth state", 400);
  }

  try {
    const accessToken = await exchangeCode({
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      redirectUri,
      code,
      verifier: deriveCodeVerifier(state, config.sessionSecret),
    });
    const profile = await fetchProfile(accessToken);

    if (!profile.emailVerified) {
      return c.text("Google account email is not verified", 403);
    }

    const allowed = isAllowedUser(config, profile.email);
    if (!allowed) {
      log(`Rejected sign-in for ${profile.email} (not in allowlist)`);
      return c.text("This account is not authorized for this instance.", 403);
    }

    log(`Signed in ${profile.email}`);
    return issueSession(c.res, allowed.name ?? profile.name, profile.email);
  } catch (error) {
    log(`OAuth callback failed: ${error instanceof Error ? error.message : String(error)}`);
    return c.text("Sign-in failed", 500);
  }
});

app.post("/auth/logout", (c) => {
  c.header("set-cookie", clearSessionCookie(secureCookies));
  return c.json({ ok: true });
});

// ── Static SPA ───────────────────────────────────────────────────────────────
// Registered last: Hono matches in order, so /api, /auth and the health probes
// above always win. In local development Vite serves the app instead and
// proxies those paths here, so a missing build is not an error.
const webDist = process.env.WEB_DIST ?? "web/dist";

app.use("/assets/*", serveStatic({ root: webDist }));

// SPA fallback — every unmatched GET renders the app shell so client-side
// routes survive a reload or a deep link.
app.get("*", serveStatic({ path: `${webDist}/index.html` }));

function issueSession(_res: Response, name: string, email: string): Response {
  const payload: SessionPayload = {
    email,
    name,
    exp: Math.floor(Date.now() / 1000) + config.sessionTtlSeconds,
  };
  const token = encodeSession(payload, config.sessionSecret);
  return new Response(null, {
    status: 302,
    headers: {
      location: "/",
      "set-cookie": buildSessionCookie(token, config.sessionTtlSeconds, secureCookies),
    },
  });
}

function currentSession(request: Request): SessionPayload | null {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token) return null;
  return decodeSession(token, config.sessionSecret);
}

// ── WebSocket ────────────────────────────────────────────────────────────────
interface SocketData {
  user: SessionUser;
  sessionId: string;
}

const server = Bun.serve<SocketData>({
  port: config.port,

  fetch(request, bunServer) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const session = currentSession(request);
      if (!session) {
        return new Response("Unauthorized", { status: 401 });
      }
      // The authenticated identity rides along in `data`, so the socket never
      // has to re-derive it from cookies after the upgrade.
      const upgraded = bunServer.upgrade(request, {
        data: {
          user: { email: session.email, name: session.name },
          sessionId: "",
        } satisfies SocketData,
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    return app.fetch(request);
  },

  websocket: {
    open(ws: ServerWebSocket<SocketData>) {
      ws.data.sessionId = registry.add(
        {
          send: (data) => ws.send(data),
          close: (code, reason) => ws.close(code, reason),
        },
        ws.data.user,
      );
    },

    message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
      registry.handleSessionMessage(
        ws.data.sessionId,
        typeof message === "string" ? message : message.toString("utf8"),
      );
    },

    close(ws: ServerWebSocket<SocketData>) {
      // Browser socket only. The upstream connection is untouched, so any
      // in-flight turn keeps running.
      registry.remove(ws.data.sessionId);
    },
  },
});

log(`Listening on http://localhost:${server.port} (public origin ${config.publicOrigin})`);
log(`App-server: ${config.appServerUrl}`);
log(`Allowlisted users: ${config.allowedUsers.map((u) => u.email).join(", ")}`);
if (config.devBypassEmail) log(`DEV BYPASS ACTIVE as ${config.devBypassEmail}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`Received ${signal}, shutting down`);
    upstream.stop();
    void server.stop(true).then(() => process.exit(0));
  });
}
