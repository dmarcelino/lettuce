import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  ReadFileResponseMessage,
  WriteFileResponseMessage,
  WsProtocolMessage,
} from "@letta-ai/letta-code/app-server-protocol";
import type { ServerWebSocket } from "bun";
import { type Context, Hono } from "hono";
import { serveStatic } from "hono/bun";
import { CF_ACCESS_JWT_HEADER, verifyAccessJwt } from "./auth/cf-access.ts";
import { checkUpgradeOrigin } from "./auth/origin.ts";
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
import { errorMessage } from "./errors.ts";
import { inlineContentType } from "./files/content-type.ts";
import {
  DEFAULT_HTTP_CAPACITY,
  DEFAULT_HTTP_REFILL_PER_SECOND,
  HttpRateLimiter,
} from "./http-rate-limit.ts";
import {
  InvalidMcpServersError,
  type McpServer,
  mergeMcpServers,
  readMcpServers,
  SettingsUnreadableError,
  validateMcpServers,
} from "./mcp/settings.ts";
import { ApprovalWatcher } from "./push/approval-watcher.ts";
import { configureWebPush, sendPush } from "./push/send.ts";
import { PushSubscriptionStore } from "./push/store.ts";
import { TurnOutcomeWatcher } from "./push/turn-watcher.ts";
import { securityHeaders } from "./security-headers.ts";
import { SETTINGS_PATH, WORKSPACE_ROOT, workspaceViolation } from "./session/protocol.ts";
import { SessionRegistry, type SessionUser } from "./session/registry.ts";
import { symlinkViolation } from "./session/symlink-guard.ts";
import { UpstreamConnection } from "./upstream/connection.ts";

const config: BffConfig = loadConfig();
const secureCookies = config.publicOrigin.startsWith("https://");

// Push is fully optional (see `config.push`'s doc comment) — null when the
// three VAPID settings aren't configured, same "degrade silently, run
// without it" pattern this repo already uses for the sandbox backend.
const pushStore = config.push
  ? new PushSubscriptionStore(config.push.subscriptionsFile, (error) =>
      log(`Push subscription persist failed: ${errorMessage(error)}`),
    )
  : null;
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

// The symlink guard inspects the workspace through this process's own mount. If
// that mount is absent — running the BFF outside the container, or a compose
// file that forgot it — every component stats as ENOENT and the guard passes
// everything. That is fail-open, so say so loudly rather than leaving it to be
// discovered by an escape.
if (!existsSync(WORKSPACE_ROOT)) {
  log(
    `! ${WORKSPACE_ROOT} is not mounted in this process: the symlink guard cannot ` +
      `verify workspace paths and will allow any lexically-in-root path. Mount the ` +
      `host workspaces directory at ${WORKSPACE_ROOT} (see docker/compose.yml).`,
  );
}

upstream.start();

// ── HTTP ─────────────────────────────────────────────────────────────────────
interface AppVariables {
  session: SessionPayload | null;
}

const app = new Hono<{ Variables: AppVariables }>();

// Applied before anything else so every response carries the hardening set,
// including the ones produced by the auth middleware below.
const hardened = securityHeaders({ publicOrigin: config.publicOrigin });
app.use("*", async (c, next) => {
  for (const [name, value] of Object.entries(hardened)) c.header(name, value);
  await next();
});

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
          const minted = mintSession(email);
          session = minted.session;
          c.header("set-cookie", minted.cookie, { append: true });
          log(`Signed in ${email} via Cloudflare Access`);
        } else {
          log(`Rejected Access sign-in for ${email} (not in allowlist)`);
        }
      } catch (error) {
        log(`Access JWT verification failed: ${errorMessage(error)}`);
      }
    }
  }

  c.set("session", session);
  await next();
});

// Throttle the API and push routes per user. The WS command path has had a
// limiter since the render loop that OOM'd the app-server; these routes are the
// more expensive half, because a download makes the app-server read a whole
// file and the BFF hold it in memory.
//
// Registered AFTER the session middleware above on purpose: keying the bucket
// needs the resolved identity. Registering it earlier would make every signed-in
// user share the single anonymous bucket, so one person's flood would throttle
// everyone else. Health probes sit outside these prefixes, so an orchestrator's
// polling never counts against a user's bucket.
const httpLimiter = new HttpRateLimiter(DEFAULT_HTTP_CAPACITY, DEFAULT_HTTP_REFILL_PER_SECOND);
const throttle = async (c: Context, next: () => Promise<void>) => {
  const session = c.get("session");
  const retryAfter = httpLimiter.take(session ? session.email : "__anonymous__");
  if (retryAfter !== null) {
    return c.text("Too many requests", {
      status: 429,
      headers: { "retry-after": String(retryAfter) },
    });
  }
  await next();
};
app.use("/api/*", throttle);
app.use("/push/*", throttle);

// The web client reads exactly three fields: `authenticated`, `auth_mode` and
// `user.email`. Everything else here is operational detail — the running
// letta-code version, backend kind, protocol version, how many sessions are
// connected — and this route is UNAUTHENTICATED, so an anonymous visitor could
// fingerprint the deployment straight from it. The full payload is served only
// to a signed-in session, where it is useful for debugging; an anonymous
// caller gets the minimum needed to render a sign-in screen.
app.get("/api/status", (c) => {
  const session = c.get("session");
  const auth_mode = config.devBypassEmail
    ? "dev-bypass"
    : config.mode === "cloudflared"
      ? "cf-access"
      : "none";

  if (!session) return c.json({ authenticated: false, auth_mode });

  return c.json({
    authenticated: true,
    auth_mode,
    user: { email: session.email },
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
  const { cookie } = mintSession(email);
  return new Response(null, {
    status: 302,
    headers: { location: "/", "set-cookie": cookie, ...hardened },
  });
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
  const endpoint = endpointOf(body);
  if (!endpoint) return c.text("Missing endpoint", 400);

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
  const endpoint = endpointOf(body);
  if (!endpoint) return c.text("Missing endpoint", 400);

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

// Delivery, proven end to end, without staging an unwatched turn. Every real
// trigger is suppressed while a visible session is on that conversation, so a
// device that is subscribed but undeliverable is otherwise indistinguishable
// from one that is simply being watched. This route skips that check and the
// per-event preferences: it is the user asking for exactly this notification.
app.post("/push/test", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!pushStore) return c.text("Push notifications are not configured on this instance", 404);

  const body = await c.req.json().catch(() => null);
  const endpoint = endpointOf(body);
  if (!endpoint) return c.text("Missing endpoint", 400);

  const record = pushStore.all().find((candidate) => candidate.endpoint === endpoint);
  if (!record) return c.text("Unknown push subscription", 404);

  try {
    const result = await sendPush(record, {
      title: "Letta",
      body: "Test notification — push is working on this device.",
      url: "/",
    });
    if (result === "gone") {
      pushStore.remove(endpoint);
      log(`Push test: ${endpoint} is gone; removed`);
      return c.text("This device's subscription has expired — turn notifications off and on", 410);
    }
    log(`Push test: sent to ${endpoint}`);
    return c.json({ ok: true });
  } catch (error) {
    log(`Push test to ${endpoint} failed: ${errorMessage(error)}`);
    return c.text(errorMessage(error), 502);
  }
});

// ── MCP settings ────────────────────────────────────────────────────────────
// MCP servers are not in the app-server protocol; they live in
// /root/.letta/settings.json under the agent's own entry. The browser may READ
// that file (see READABLE_EXCEPTIONS) but must never WRITE it: an mcpServers
// entry is an arbitrary command line the app-server execs as root. These routes
// do the merge server-side against the file as it currently stands, so the
// browser never holds a write handle on it and two editors cannot clobber each
// other with stale copies.

async function readSettingsFile(): Promise<string> {
  const response = await upstream.request<ReadFileResponseMessage>({
    type: "read_file",
    path: SETTINGS_PATH,
    request_id: `bff-mcp-read-${randomUUID()}`,
    encoding: "utf8",
  });
  if (!response.success || typeof response.content !== "string") {
    throw new SettingsUnreadableError(response.error ?? "Could not read settings.json");
  }
  return response.content;
}

app.get("/api/mcp", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  const agentId = c.req.query("agent_id");
  if (!agentId) return c.text("Missing agent_id", 400);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);

  try {
    const servers = readMcpServers(await readSettingsFile(), agentId);
    return c.json({ servers });
  } catch (error) {
    if (error instanceof SettingsUnreadableError) return c.text(error.message, 502);
    return c.text(errorMessage(error), 502);
  }
});

app.put("/api/mcp", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);

  const body = await c.req.json().catch(() => null);
  const agentId = (body as { agent_id?: unknown } | null)?.agent_id;
  if (typeof agentId !== "string" || !agentId) return c.text("Missing agent_id", 400);

  let servers: McpServer[];
  try {
    servers = validateMcpServers((body as { servers?: unknown }).servers);
  } catch (error) {
    if (error instanceof InvalidMcpServersError) return c.text(error.message, 400);
    return c.text(errorMessage(error), 400);
  }

  let merged: string;
  try {
    merged = mergeMcpServers(await readSettingsFile(), agentId, servers);
  } catch (error) {
    if (error instanceof SettingsUnreadableError) return c.text(error.message, 502);
    return c.text(errorMessage(error), 502);
  }

  try {
    const written = await upstream.request<WriteFileResponseMessage>({
      type: "write_file",
      path: SETTINGS_PATH,
      content: merged,
      request_id: `bff-mcp-write-${randomUUID()}`,
    });
    if (written?.success !== true) {
      return c.text(written?.error ?? "Failed to write settings.json", 502);
    }
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }

  // Settings are read at load time, so the runtime must re-read them. Fire and
  // forget: `reload` has no meaningful response for us beyond the write having
  // landed, and blocking the request on a runtime restart would be worse.
  try {
    upstream.sendInternal({
      type: "execute_command",
      command_id: "reload",
      request_id: `bff-mcp-reload-${randomUUID()}`,
      runtime: { agent_id: agentId, conversation_id: "default" },
    });
  } catch (error) {
    log(`MCP save: reload failed after a successful write: ${errorMessage(error)}`);
  }

  return c.json({ ok: true, servers });
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

  // Same reason as the WS path: a symlink under /work resolves outside it and
  // the app-server follows it without resolving.
  const symlink = symlinkViolation(path, WORKSPACE_ROOT);
  if (symlink) return c.text(symlink, 400);

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
    return c.text(errorMessage(error), 502);
  }

  if (!response.success || typeof response.content !== "string") {
    return c.text(response.error ?? "Failed to read file", 404);
  }

  // A Buffer IS a Uint8Array, so it goes straight to Response. Wrapping it in
  // `new Uint8Array(bytes)` would copy the whole decoded file again for no
  // reason — and this route already holds the base64 string from upstream plus
  // the decoded bytes.
  const bytes = Buffer.from(response.content, "base64");
  const filename = (path.split("/").pop() || "download").replaceAll('"', "");
  // `?inline=1` (chat-message links) asks for a viewable response; only PDFs
  // and raster images actually get one — see `inlineContentType`.
  const inlineType = c.req.query("inline") != null ? inlineContentType(filename) : null;
  return new Response(bytes, {
    headers: {
      "content-type": inlineType ?? "application/octet-stream",
      "content-disposition": `${inlineType ? "inline" : "attachment"}; filename="${filename}"`,
      "content-length": String(bytes.length),
      // Spread last-but-one: the hardening set must survive, and `nosniff` in
      // particular matters here because this is the route that hands the
      // browser agent-authored bytes.
      ...hardened,
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

/** A fresh session for `email`, and the `set-cookie` value that carries it. */
function mintSession(email: string): { session: SessionPayload; cookie: string } {
  const session: SessionPayload = {
    email,
    exp: Math.floor(Date.now() / 1000) + config.sessionTtlSeconds,
  };
  const token = encodeSession(session, config.sessionSecret);
  return { session, cookie: buildSessionCookie(token, config.sessionTtlSeconds, secureCookies) };
}

/** The non-empty `endpoint` a push request body names, or null. */
function endpointOf(body: unknown): string | null {
  const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
  return typeof endpoint === "string" && endpoint ? endpoint : null;
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
      // A WebSocket handshake is not subject to CORS, and SameSite=Lax does not
      // cover upgrades — so without this check any page the signed-in user
      // visits could open a socket to this BFF and act as them.
      const origin = checkUpgradeOrigin(
        request.headers.get("origin"),
        config.mode,
        config.publicOrigin,
        request.headers.get("host"),
      );
      if (!origin.ok) {
        log(`Refused /ws upgrade: ${origin.reason}`);
        return new Response("Forbidden origin", { status: 403, headers: hardened });
      }

      const session = currentSession(request);
      if (!session) {
        return new Response("Unauthorized", { status: 401, headers: hardened });
      }
      // The authenticated identity rides along in `data`, so the socket never
      // has to re-derive it from cookies after the upgrade.
      const upgraded = bunServer.upgrade(request, {
        data: {
          user: { email: session.email },
          sessionId: "",
        } satisfies SocketData,
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400, headers: hardened });
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
