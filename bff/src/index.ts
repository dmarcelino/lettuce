import { randomUUID } from "node:crypto";
import type {
  ReadFileResponseMessage,
  WsProtocolMessage,
} from "@letta-ai/letta-code/app-server-protocol";
import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { CF_ACCESS_JWT_HEADER, verifyAccessJwt } from "./auth/cf-access.ts";
import {
  buildSessionCookie,
  clearSessionCookie,
  decodeSession,
  encodeSession,
  readCookie,
  SESSION_COOKIE,
  type SessionPayload,
} from "./auth/session-cookie.ts";
import { type BffConfig, isAllowedUser, loadConfig } from "./config.ts";
import { inlineContentType } from "./files/content-type.ts";
import { ApprovalWatcher } from "./push/approval-watcher.ts";
import { configureWebPush } from "./push/send.ts";
import { PushSubscriptionStore } from "./push/store.ts";
import { TurnOutcomeWatcher } from "./push/turn-watcher.ts";
import { workspaceViolation } from "./session/protocol.ts";
import { SessionRegistry, type SessionUser } from "./session/registry.ts";
import { UpstreamConnection } from "./upstream/connection.ts";

const config: BffConfig = loadConfig();
const secureCookies = config.publicOrigin.startsWith("https://");

// Push is fully optional (see `config.push`'s doc comment) — null when the
// three VAPID settings aren't configured, same "degrade silently, run
// without it" pattern this repo already uses for the sandbox backend.
const pushStore = config.push ? new PushSubscriptionStore(config.push.subscriptionsFile) : null;
if (config.push) configureWebPush(config.push);
const turnOutcomeWatcher = pushStore ? new TurnOutcomeWatcher(pushStore, log) : null;
const approvalWatcher = pushStore ? new ApprovalWatcher(pushStore, log) : null;

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
  onFrame: (frame: WsProtocolMessage) => {
    registry.handleUpstreamFrame(frame);
    turnOutcomeWatcher?.observe(frame, (scopeKey) => registry.isScopeWatched(scopeKey));
    approvalWatcher?.observe(frame, (scopeKey) => registry.isScopeWatched(scopeKey));
  },
  onStateChange: (state, info) => {
    log(`Upstream state: ${state}`);
    registry.broadcastUpstreamState(state, info);
  },
  log,
});

const registry = new SessionRegistry(upstream, config.frameBufferSize, log);

upstream.start();

// ── HTTP ─────────────────────────────────────────────────────────────────────
interface AppVariables {
  session: SessionPayload | null;
}

const app = new Hono<{ Variables: AppVariables }>();

app.get("/healthz", (c) => c.text("ok\n"));

app.get("/readyz", (c) =>
  upstream.isReady() ? c.text("ok\n") : c.text(`app-server ${upstream.getState()}\n`, 503),
);

// Resolves the session for every other route, minting one transparently from
// a Cloudflare Access JWT the first time it sees one with no cookie yet.
// After that first hit, every request (including this one) uses the cheap
// cookie check below — no per-request JWKS/JWT verification. Applied as
// middleware (rather than one dedicated login route) so it also covers plain
// XHRs like `/api/status`, not just top-level navigations.
app.use("*", async (c, next) => {
  let session = currentSession(c.req.raw);

  // Local mode never looks at this header at all, even if one shows up (e.g.
  // a curious client hitting the LAN port directly) — there is no team
  // domain/audience configured to verify it against, and not even trying is
  // clearer than an incidental failure inside verifyAccessJwt.
  if (!session && config.mode === "cloudflared") {
    const jwt = c.req.header(CF_ACCESS_JWT_HEADER);
    if (jwt) {
      try {
        const { email } = await verifyAccessJwt(jwt, {
          teamDomain: config.cfAccessTeamDomain,
          audience: config.cfAccessAud,
          issuer: config.cfAccessIssuer,
        });
        if (isAllowedUser(config, email)) {
          session = {
            email,
            name: email,
            exp: Math.floor(Date.now() / 1000) + config.sessionTtlSeconds,
          };
          const token = encodeSession(session, config.sessionSecret);
          c.header(
            "set-cookie",
            buildSessionCookie(token, config.sessionTtlSeconds, secureCookies),
            {
              append: true,
            },
          );
          log(`Signed in ${email} via Cloudflare Access`);
        } else {
          log(`Rejected Access sign-in for ${email} (not in allowlist)`);
        }
      } catch (error) {
        log(
          `Access JWT verification failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  c.set("session", session);
  await next();
});

app.get("/api/status", (c) => {
  const session = c.get("session");
  return c.json({
    authenticated: session !== null,
    auth_mode: config.devBypassEmail
      ? "dev-bypass"
      : config.mode === "cloudflared"
        ? "cf-access"
        : "none",
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

// Dev-bypass's only self-service entry point. In production (Access
// enforcing) there is nothing for this route to do — a visitor who reaches
// the origin at all already has a valid Access JWT, which the middleware
// above turns into a session before any handler runs.
app.get("/auth/login", (c) => {
  if (config.devBypassEmail) return c.redirect("/auth/dev-login");
  return c.text("Sign in via Cloudflare Access.", 400);
});

app.get("/auth/dev-login", (c) => {
  const email = config.devBypassEmail;
  if (!email) return c.text("Dev login is disabled", 404);

  // Unset ALLOWED_USERS makes the bypass email its own allowlist, so this can
  // only fire when both were set explicitly and name different people — a real
  // misconfiguration rather than the self-contradiction it used to report.
  if (!isAllowedUser(config, email)) {
    return c.text(`DEV_BYPASS_EMAIL ${email} is not listed in ALLOWED_USERS`, 403);
  }

  log(`Dev login as ${email} (NO AUTHENTICATION — loopback only)`);
  return issueSession(email, email);
});

app.post("/auth/logout", (c) => {
  c.header("set-cookie", clearSessionCookie(secureCookies));
  return c.json({ ok: true });
});

app.get("/push/vapid-key", (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!config.push) return c.text("Push notifications are not configured on this instance", 404);
  return c.json({ key: config.push.vapidPublicKey });
});

app.post("/push/subscribe", async (c) => {
  const session = c.get("session");
  if (!session) return c.text("Unauthorized", 401);
  if (!pushStore) return c.text("Push notifications are not configured on this instance", 404);

  try {
    const body = await c.req.json();
    const record = pushStore.add(
      body,
      session.email,
      (body as { preferences?: unknown })?.preferences,
    );
    return c.json({ ok: true, preferences: record.preferences });
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "Malformed subscription", 400);
  }
});

app.post("/push/unsubscribe", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!pushStore) return c.text("Push notifications are not configured on this instance", 404);

  const body = await c.req.json().catch(() => null);
  const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
  if (typeof endpoint !== "string" || !endpoint) return c.text("Missing endpoint", 400);

  pushStore.remove(endpoint);
  return c.json({ ok: true });
});

app.get("/push/preferences", (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!pushStore) return c.text("Push notifications are not configured on this instance", 404);

  const endpoint = c.req.query("endpoint");
  if (!endpoint) return c.text("Missing endpoint", 400);

  const preferences = pushStore.getPreferences(endpoint);
  if (!preferences) return c.text("Unknown push subscription", 404);
  return c.json({ preferences });
});

app.post("/push/preferences", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!pushStore) return c.text("Push notifications are not configured on this instance", 404);

  const body = await c.req.json().catch(() => null);
  const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
  if (typeof endpoint !== "string" || !endpoint) return c.text("Missing endpoint", 400);

  try {
    const record = pushStore.updatePreferences(
      endpoint,
      (body as { preferences?: unknown }).preferences,
    );
    return c.json({ ok: true, preferences: record.preferences });
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "Unknown push subscription", 404);
  }
});

// A real HTTP URL for a workspace file, so a chat-message link or the Files
// tab can hand the browser a plain download instead of driving the read_file
// WS command itself. Goes through the app-server exactly like every other
// file command — no new upstream surface, just a new way to reach the
// existing one over HTTP instead of the browser's multiplexed WS session.
app.get("/api/files/download", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);

  const path = c.req.query("path");
  if (!path) return c.text("Missing path", 400);

  const violation = workspaceViolation({ type: "read_file", path });
  if (violation) return c.text(violation, 400);

  if (!upstream.isReady()) return c.text("App-server is not connected", 503);

  let response: ReadFileResponseMessage;
  try {
    response = await upstream.request<ReadFileResponseMessage>({
      type: "read_file",
      path,
      request_id: `bff-download-${randomUUID()}`,
      encoding: "base64",
    });
  } catch (error) {
    return c.text(error instanceof Error ? error.message : String(error), 502);
  }

  if (!response.success || typeof response.content !== "string") {
    return c.text(response.error ?? "Failed to read file", 404);
  }

  const bytes = Buffer.from(response.content, "base64");
  const filename = (path.split("/").pop() || "download").replaceAll('"', "");
  // `?inline=1` (chat-message links) asks for a viewable response; only PDFs
  // and raster images actually get one — see `inlineContentType`.
  const inlineType = c.req.query("inline") != null ? inlineContentType(filename) : null;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": inlineType ?? "application/octet-stream",
      "content-disposition": `${inlineType ? "inline" : "attachment"}; filename="${filename}"`,
      "content-length": String(bytes.length),
    },
  });
});

// ── Static SPA ───────────────────────────────────────────────────────────────
// Registered last: Hono matches in order, so /api, /auth and the health probes
// above always win. In local development Vite serves the app instead and
// proxies those paths here, so a missing build is not an error.
const webDist = process.env.WEB_DIST ?? "web/dist";

// Any real file in the build — hashed `/assets/*`, and the root-level PWA files
// `sw.js`, `manifest.webmanifest`, `icon-*.png`. Without this the catch-all
// below answered `/sw.js` and `/manifest.webmanifest` with the HTML shell, so
// the service worker never registered and the manifest never parsed — the app
// looked like a PWA in source but could not be installed. `serveStatic` calls
// `next()` when the file is absent, so client routes still fall through.
app.get("*", serveStatic({ root: webDist }));

// SPA fallback — every unmatched GET renders the app shell so client-side
// routes survive a reload or a deep link.
app.get("*", serveStatic({ path: `${webDist}/index.html` }));

function issueSession(name: string, email: string, extraCookies: string[] = []): Response {
  const payload: SessionPayload = {
    email,
    name,
    exp: Math.floor(Date.now() / 1000) + config.sessionTtlSeconds,
  };
  const token = encodeSession(payload, config.sessionSecret);
  const headers = new Headers({ location: "/" });
  headers.append("set-cookie", buildSessionCookie(token, config.sessionTtlSeconds, secureCookies));
  for (const cookie of extraCookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
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

// PUBLIC_ORIGIN is only a declaration of intent; the bind address is the
// enforcement. The bypass stays on loopback unless DEV_BYPASS_ALLOW_REMOTE
// explicitly says otherwise, so it cannot reach the network by accident.
const bindHostname =
  config.devBypassEmail && !config.devBypassAllowRemote ? "127.0.0.1" : "0.0.0.0";

const server = Bun.serve<SocketData>({
  port: config.port,
  hostname: bindHostname,

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

log(`Mode: ${config.mode}`);
log(`Listening on ${bindHostname}:${server.port} (public origin ${config.publicOrigin})`);
log(`App-server: ${config.appServerUrl}`);
log(`Allowlisted users: ${config.allowedUsers.join(", ") || "(none — nobody can sign in)"}`);
if (config.devBypassEmail) {
  log("!".repeat(72));
  log(`DEV BYPASS ACTIVE — no authentication. Any request gets a session as`);
  log(`${config.devBypassEmail}.`);
  log(
    config.devBypassAllowRemote
      ? `EXPOSED ON THE NETWORK at ${config.publicOrigin} by DEV_BYPASS_ALLOW_REMOTE=true.`
      : "Bound to 127.0.0.1 only; not reachable off this machine.",
  );
  log("!".repeat(72));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`Received ${signal}, shutting down`);
    upstream.stop();
    void server.stop(true).then(() => process.exit(0));
  });
}
