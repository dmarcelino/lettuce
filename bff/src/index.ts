import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  AgentListResponseMessage,
  AgentRetrieveResponseMessage,
  ExecuteCommandResponseMessage,
  ListInDirectoryResponseMessage,
  ReadFileResponseMessage,
  SkillDisableResponseMessage,
  SkillEnableResponseMessage,
  WriteFileResponseMessage,
  WsProtocolMessage,
} from "@letta-ai/letta-code/app-server-protocol";
import type { ServerWebSocket } from "bun";
import { type Context, Hono } from "hono";
import { serveStatic } from "hono/bun";
import { installAgentSkills, readSkillTree } from "./agent-skills.ts";
import { checkUpgradeOrigin } from "./auth/origin.ts";
import { resolveSession } from "./auth/resolve-session.ts";
import {
  buildSessionCookie,
  clearSessionCookie,
  encodeSession,
  type SessionPayload,
} from "./auth/session-cookie.ts";
import { isCodexThreadId } from "./codex/rollout.ts";
import {
  type CodexFileIo,
  getCodexRun,
  listCodexRuns,
  loadCodexSettings,
  reapplyCodexSettings,
  saveCodexSettings,
  suggestedCodexBaseUrl,
} from "./codex/service.ts";
import { InvalidCodexSettingsError, toPublicCodexSettings } from "./codex/settings.ts";
import { type BffConfig, googleWritesAllowed, isAllowedUser, loadConfig } from "./config.ts";
import { errorMessage } from "./errors.ts";
import { inlineContentType } from "./files/content-type.ts";
import { createGoogleFsIo } from "./google/fs-io.ts";
import { GoogleOAuthError } from "./google/oauth.ts";
import { GoogleAccessError, GoogleService } from "./google/service.ts";
import { InvalidGoogleSettingsError } from "./google/settings.ts";
import {
  DEFAULT_HTTP_CAPACITY,
  DEFAULT_HTTP_REFILL_PER_SECOND,
  HttpRateLimiter,
} from "./http-rate-limit.ts";
import { ensureMcpServers, loadMcpServers, type McpIo, saveMcpServers } from "./mcp/service.ts";
import {
  InvalidMcpServersError,
  type McpServer,
  SettingsUnreadableError,
  validateMcpServers,
} from "./mcp/settings.ts";
import { MCP_SKILL_NAME } from "./mcp/skill.ts";
import { AgentNames } from "./push/agent-names.ts";
import { ApprovalWatcher } from "./push/approval-watcher.ts";
import { configureWebPush, sendPush } from "./push/send.ts";
import { PushSubscriptionStore } from "./push/store.ts";
import { TurnOutcomeWatcher } from "./push/turn-watcher.ts";
import { securityHeaders } from "./security-headers.ts";
import { scopeKeyOf } from "./session/buffer.ts";
import { WORKSPACE_ROOT, workspaceViolation } from "./session/protocol.ts";
import { SessionRegistry, type SessionUser } from "./session/registry.ts";
import { symlinkViolation } from "./session/symlink-guard.ts";
import { TurnErrorLog } from "./session/turn-errors.ts";
import { drainActiveTurns } from "./shutdown.ts";
import { hostSkillFs, upstreamSkillFs } from "./skills/fs.ts";
import { InvalidSkillScopeError, SkillCatalog } from "./skills/service.ts";
import { UpstreamConnection } from "./upstream/connection.ts";
import { ddgCaller } from "./web-tools/ddg.ts";
import { handleInternalWebTools } from "./web-tools/http.ts";
import {
  loadWebToolsSettings,
  retireSeededDdgMcp,
  saveWebToolsSettings,
  syncWebToolsMod,
  type WebToolsIo,
} from "./web-tools/install.ts";
import { type WebToolsBackends, webSearch } from "./web-tools/service.ts";
import { InvalidWebToolsSettingsError } from "./web-tools/settings.ts";
import { webToolsStatus } from "./web-tools/status.ts";

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
// Push titles name the agent. Looked up through the permanent connection and
// cached; a failed lookup falls back to "Letta" rather than delaying the push.
const agentNames = new AgentNames(async (agentId) => {
  const response = await upstream.request<AgentRetrieveResponseMessage>(
    { type: "agent_retrieve", request_id: `bff-agent-name-${randomUUID()}`, agent_id: agentId },
    10_000,
  );
  return response.success ? (response.agent?.name ?? null) : null;
});
const turnOutcomeWatcher = pushStore ? new TurnOutcomeWatcher(pushStore, log, agentNames) : null;
const approvalWatcher = pushStore ? new ApprovalWatcher(pushStore, log, agentNames) : null;
const turnErrors = new TurnErrorLog();

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
    turnErrors.observe(frame);
    turnOutcomeWatcher?.observe(frame, (scopeKey) => registry.isScopeWatched(scopeKey));
    approvalWatcher?.observe(frame, (scopeKey) => registry.isScopeWatched(scopeKey));
  },
  onStateChange: (state, info) => {
    log(`Upstream state: ${state}`);
    registry.broadcastUpstreamState(state, info);
    if (state === "connected") {
      skillCatalog.reset();
      void installShippedSkills();
      // One after another: each of these rewrites the shared MCP list, and two
      // read-modify-writes at once would drop one's change.
      void ensureMcpServers(mcpIo)
        .then((servers) => log(`MCP: ${servers.length} shared server(s) configured`))
        .catch((error) => log(`MCP: could not sync shared servers: ${errorMessage(error)}`))
        .then(() => retireSeededDdgMcp(webToolsIo, mcpIo))
        .then(
          (removed) => removed && log("MCP: removed duckduckgo — web search is a native tool now"),
        )
        .catch((error) => log(`MCP: could not retire duckduckgo: ${errorMessage(error)}`))
        .then(() => googleService.reapply())
        .catch((error) => log(`Google: could not re-render config: ${errorMessage(error)}`));
      void reapplyCodexSettings(codexIo)
        .then((applied) => applied && log("Codex: re-rendered config from saved settings"))
        .catch((error) => log(`Codex: could not re-render config: ${errorMessage(error)}`));
      void reapplyWebToolsMod();
    }
  },
  log,
});

const registry = new SessionRegistry(upstream, config.frameBufferSize, log);

// Skills this repo ships to every agent (docker/agent-skills), installed into
// the app-server's global skills directory on each connect — see
// `agent-skills.ts` for why this is not a bind mount. The files travel in the
// bff image at the same relative path as in the repo, so dev works unchanged.
const agentSkillsDir =
  process.env.AGENT_SKILLS_DIR ?? new URL("../../docker/agent-skills", import.meta.url).pathname;
async function installShippedSkills(): Promise<void> {
  await installAgentSkills(
    readSkillTree(agentSkillsDir),
    async (path, content) => {
      const response = await upstream.request<WriteFileResponseMessage>({
        type: "write_file",
        path,
        content,
        request_id: `bff-skill-${randomUUID()}`,
      });
      if (response?.success !== true) throw new Error(response?.error ?? "write_file failed");
    },
    log,
  );
}

// Codex workers' files, reached through the app-server like every other file
// the BFF touches — see `codex/settings.ts`. Only these routes use it, never a
// browser: `/root/.letta` is outside the workspace clamp on purpose.
const codexIo: CodexFileIo = {
  async read(path) {
    const response = await upstream.request<ReadFileResponseMessage>({
      type: "read_file",
      path,
      encoding: "utf8",
      request_id: `bff-codex-read-${randomUUID()}`,
    });
    if (response.success && typeof response.content === "string") return response.content;
    if (/ENOENT|no such file/i.test(response.error ?? "")) return null;
    throw new Error(response.error ?? `Could not read ${path}`);
  },
  async write(path, content) {
    const response = await upstream.request<WriteFileResponseMessage>({
      type: "write_file",
      path,
      content,
      request_id: `bff-codex-write-${randomUUID()}`,
    });
    if (response?.success !== true) throw new Error(response?.error ?? `Could not write ${path}`);
  },
  async listFiles(dir) {
    const response = await upstream.request<ListInDirectoryResponseMessage>({
      type: "list_in_directory",
      path: dir,
      include_files: true,
      request_id: `bff-codex-list-${randomUUID()}`,
    });
    if (response.success) return response.files ?? [];
    if (/ENOENT|no such file/i.test(response.error ?? "")) return null;
    throw new Error(response.error ?? `Could not list ${dir}`);
  },
};

// Settings → Skills (see `skills/`). Bundled skills are in the app-server image,
// so they come over the connection; every other root is read from the BFF's
// read-only mounts, because the protocol's listings skip symlinks.
const skillCatalog = new SkillCatalog(
  hostSkillFs,
  upstreamSkillFs({
    async list(dir) {
      const response = await upstream.request<ListInDirectoryResponseMessage>({
        type: "list_in_directory",
        path: dir,
        include_files: true,
        request_id: `bff-skills-list-${randomUUID()}`,
      });
      if (response.success) return { folders: response.folders, files: response.files ?? [] };
      if (/ENOENT|no such file/i.test(response.error ?? "")) return null;
      throw new Error(response.error ?? `Could not list ${dir}`);
    },
    async read(path) {
      const content = await codexIo.read(path);
      if (content === null) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  }),
  () =>
    new Map([
      ...readSkillTree(agentSkillsDir).map(
        (file) => [file.path.split("/")[0] ?? "", "this app"] as const,
      ),
      [MCP_SKILL_NAME, "Settings → MCP"],
    ]),
);

// The shared MCP list and its skill (see `mcp/`), through the app-server like
// the Codex files. Reads reuse `codexIo.read` — same file, same ENOENT → null.
const mcpIo: McpIo = {
  read: (path) => codexIo.read(path),
  write: (path, content) => codexIo.write(path, content),
  async enableSkill(skillPath) {
    const response = await upstream.request<SkillEnableResponseMessage>({
      type: "skill_enable",
      skill_path: skillPath,
      request_id: `bff-mcp-skill-enable-${randomUUID()}`,
    });
    if (response?.success !== true) throw new Error(response?.error ?? "skill_enable failed");
  },
  async disableSkill(name) {
    const response = await upstream.request<SkillDisableResponseMessage>({
      type: "skill_disable",
      name,
      request_id: `bff-mcp-skill-disable-${randomUUID()}`,
    });
    // Nothing linked is the state we want, not a failure.
    if (response?.success !== true && !/not found/i.test(response?.error ?? "")) {
      throw new Error(response?.error ?? "skill_disable failed");
    }
  },
};

// Native web tools (see `web-tools/`): the mod that registers `web_search` /
// `fetch_webpage` in the app-server, and the backends its calls land on.
const webToolsBackends = (): WebToolsBackends => ({
  searxngUrl: config.webTools.searxngUrl,
  ddg: config.webTools.ddgMcpUrl ? ddgCaller(config.webTools.ddgMcpUrl) : null,
});
const webToolsIo: WebToolsIo = {
  read: codexIo.read,
  write: codexIo.write,
  // `reload` needs an agent runtime to run in; which agent does not matter —
  // it reloads the global mods for the whole process.
  async reloadMods() {
    const list = await upstream.request<AgentListResponseMessage>({
      type: "agent_list",
      request_id: `bff-web-tools-agents-${randomUUID()}`,
      query: { limit: 1 },
    });
    const agentId = list.success ? list.agents[0]?.id : undefined;
    if (!agentId) return false;
    const response = await upstream.request<ExecuteCommandResponseMessage>({
      type: "execute_command",
      command_id: "reload",
      request_id: `bff-web-tools-reload-${randomUUID()}`,
      runtime: { agent_id: agentId, conversation_id: "default" },
    });
    if (!response.success) throw new Error(response.output || "reload failed");
    return true;
  },
};
/** Retries a reload that could not run yet (no agent existed) until one can. */
let webToolsReloadRetry: ReturnType<typeof setInterval> | null = null;
async function reapplyWebToolsMod(): Promise<void> {
  try {
    const settings = await loadWebToolsSettings(webToolsIo);
    const result = await syncWebToolsMod(webToolsIo, {
      enabled: settings.enabled,
      port: config.port,
    });
    if (result !== "unchanged")
      log(`Web tools: mod ${result} (${settings.enabled ? "on" : "off"})`);
    if (result === "reload-pending") scheduleWebToolsReload();
  } catch (error) {
    log(`Web tools: could not install the mod: ${errorMessage(error)}`);
  }
}
function scheduleWebToolsReload(): void {
  if (webToolsReloadRetry) return;
  webToolsReloadRetry = setInterval(() => {
    if (!upstream.isReady()) return;
    void webToolsIo
      .reloadMods()
      .then((done) => {
        if (!done || !webToolsReloadRetry) return;
        clearInterval(webToolsReloadRetry);
        webToolsReloadRetry = null;
        log("Web tools: mod reloaded");
      })
      .catch((error) => log(`Web tools: reload failed: ${errorMessage(error)}`));
  }, 30_000);
}

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
// cookie check — no per-request JWKS/JWT verification. Applied as middleware
// (rather than one dedicated login route) so it also covers plain XHRs like
// `/api/status`, not just top-level navigations. The `/ws` upgrade, which runs
// before Hono, resolves through the same function.
const sessionDeps = { config, mint: mintSession, log };
app.use("*", async (c, next) => {
  const resolved = await resolveSession(c.req.raw, sessionDeps);
  if (resolved?.setCookie) c.header("set-cookie", resolved.setCookie, { append: true });
  c.set("session", resolved?.session ?? null);
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

// ── MCP servers ─────────────────────────────────────────────────────────────
// One shared list for every agent, in a settings file only the BFF writes and
// only `letta mcp` (run from agent shells with HOME pointed at it) reads — see
// `mcp/settings.ts` for why upstream's per-agent settings.json cannot hold it.
// The browser never gets a write handle on it: an MCP entry is a command line
// that agent shells will exec.

app.get("/api/mcp", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);

  try {
    return c.json({ servers: await loadMcpServers(mcpIo) });
  } catch (error) {
    if (error instanceof SettingsUnreadableError) return c.text(error.message, 502);
    return c.text(errorMessage(error), 502);
  }
});

app.put("/api/mcp", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);

  const body = await c.req.json().catch(() => null);
  let servers: McpServer[];
  try {
    servers = validateMcpServers((body as { servers?: unknown } | null)?.servers);
  } catch (error) {
    if (error instanceof InvalidMcpServersError) return c.text(error.message, 400);
    return c.text(errorMessage(error), 400);
  }

  // No reload: nothing in the app-server process reads this file. The next
  // `letta mcp` call and the next turn's skill listing both see it from disk.
  try {
    await saveMcpServers(mcpIo, servers);
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }
  return c.json({ ok: true, servers });
});

// ── Skills ──────────────────────────────────────────────────────────────────
// Upstream publishes the skill list only on a live conversation runtime, which
// is evicted between turns — so the BFF discovers it itself. See
// `skills/discovery.ts`.

app.get("/api/skills", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  const agentId = c.req.query("agent_id");
  if (!agentId) return c.text("agent_id is required", 400);
  try {
    return c.json(await skillCatalog.list(agentId, c.req.query("cwd")));
  } catch (error) {
    if (error instanceof InvalidSkillScopeError) return c.text(error.message, 400);
    return c.text(errorMessage(error), 502);
  }
});

// ── Codex workers ───────────────────────────────────────────────────────────
// Settings → Codex, and the run viewer. See `codex/` for what the files are and
// why the BFF, not the browser, touches them.

app.get("/api/codex/settings", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  try {
    const [settings, suggestedBaseUrl] = await Promise.all([
      loadCodexSettings(codexIo),
      suggestedCodexBaseUrl(codexIo),
    ]);
    return c.json({ settings: toPublicCodexSettings(settings), suggestedBaseUrl });
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }
});

app.put("/api/codex/settings", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  const body = await c.req.json().catch(() => null);
  try {
    const saved = await saveCodexSettings(codexIo, body);
    return c.json({ settings: toPublicCodexSettings(saved) });
  } catch (error) {
    if (error instanceof InvalidCodexSettingsError) return c.text(error.message, 400);
    return c.text(errorMessage(error), 502);
  }
});

// Settings → Web: the native web tools' switch, backend status and a test search.
app.get("/api/web-tools/settings", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  try {
    const settings = await loadWebToolsSettings(webToolsIo);
    return c.json({ settings: { enabled: settings.enabled } });
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }
});

app.put("/api/web-tools/settings", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  const body = await c.req.json().catch(() => null);
  try {
    const saved = await saveWebToolsSettings(webToolsIo, body, config.port);
    if (saved.mod === "reload-pending") scheduleWebToolsReload();
    return c.json({ settings: { enabled: saved.settings.enabled }, mod: saved.mod });
  } catch (error) {
    if (error instanceof InvalidWebToolsSettingsError) return c.text(error.message, 400);
    return c.text(errorMessage(error), 502);
  }
});

app.get("/api/web-tools/status", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  return c.json(
    await webToolsStatus({
      searxngUrl: config.webTools.searxngUrl,
      ddgMcpUrl: config.webTools.ddgMcpUrl,
      read: codexIo.read,
    }),
  );
});

// The same search an agent's `web_search` runs, so the settings screen can
// prove the backends answer without starting a turn.
app.post("/api/web-tools/test", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  const body = (await c.req.json().catch(() => null)) as { query?: unknown } | null;
  return c.json(await webSearch({ query: body?.query, max_results: 5 }, webToolsBackends()));
});

app.get("/api/codex/runs", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 10, 1), 30);
  try {
    return c.json({ runs: await listCodexRuns(codexIo, limit) });
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }
});

app.get("/api/codex/runs/:threadId", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!upstream.isReady()) return c.text("App-server is not connected", 503);
  const threadId = c.req.param("threadId");
  // The id becomes part of a file lookup; only a real Codex thread id gets that far.
  if (!isCodexThreadId(threadId)) return c.text("Not a Codex thread id", 400);
  try {
    const run = await getCodexRun(codexIo, threadId);
    return run ? c.json({ run }) : c.text("No such Codex run", 404);
  } catch (error) {
    return c.text(errorMessage(error), 502);
  }
});

// ── Google (Gmail / Calendar / Tasks) ───────────────────────────────────────
// Agents use Google through the `google-mcp` sidecar; this is where the user
// decides how far. The policy and the token live on volumes only the BFF and
// the sidecar mount — never the app-server, where agent shells run — so an
// agent cannot change its own access. See `google/`.

/** The shared MCP list is only how agents find the sidecar; access is decided there. */
async function syncGoogleMcpEntry(serving: boolean): Promise<void> {
  if (!upstream.isReady()) return; // retried by `reapply` on the next connect
  const servers = await loadMcpServers(mcpIo);
  const listed = servers.some((server) => server.url === config.google.mcpUrl);
  if (serving === listed) return;
  await saveMcpServers(
    mcpIo,
    serving
      ? [...servers, { name: "google", transport: "http", url: config.google.mcpUrl }]
      : servers.filter((server) => server.url !== config.google.mcpUrl),
  );
  log(`Google: ${serving ? "added to" : "removed from"} the shared MCP list`);
}

const googleService = new GoogleService({
  io: createGoogleFsIo(config.google.policyDir, config.google.credsDir),
  fetch: (input, init) => fetch(input, init),
  redirectUri: config.google.redirectUri,
  syncMcpEntry: syncGoogleMcpEntry,
  log,
});

/** Whether the sidecar answers at all — it serves nothing while disabled. */
async function googleSidecarUp(): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", config.google.mcpUrl), {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function googleWriteRefusal(c: Context): Response | null {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  if (!googleWritesAllowed(config)) {
    return c.text(
      "Google access cannot be changed while DEV_BYPASS_EMAIL is set: agents can sign " +
        "themselves in through the bypass. Use Cloudflare Access, or set " +
        "GOOGLE_ALLOW_DEV_BYPASS=true on a machine only you use.",
      403,
    );
  }
  return null;
}

function googleErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof InvalidGoogleSettingsError || error instanceof GoogleAccessError) {
    return c.text(error.message, 400);
  }
  if (error instanceof GoogleOAuthError) return c.text(error.message, 502);
  return c.text(errorMessage(error), 500);
}

app.get("/api/google", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  try {
    const [settings, sidecarUp] = await Promise.all([googleService.status(), googleSidecarUp()]);
    return c.json({
      settings,
      sidecarUp,
      redirectUri: config.google.redirectUri,
      writable: googleWritesAllowed(config),
    });
  } catch (error) {
    return googleErrorResponse(c, error);
  }
});

app.put("/api/google", async (c) => {
  const refused = googleWriteRefusal(c);
  if (refused) return refused;
  const body = await c.req.json().catch(() => null);
  try {
    return c.json(await googleService.save(body));
  } catch (error) {
    return googleErrorResponse(c, error);
  }
});

app.post("/api/google/connect", async (c) => {
  const refused = googleWriteRefusal(c);
  if (refused) return refused;
  try {
    return c.json({ url: await googleService.startConnect() });
  } catch (error) {
    return googleErrorResponse(c, error);
  }
});

app.post("/api/google/disconnect", async (c) => {
  const refused = googleWriteRefusal(c);
  if (refused) return refused;
  try {
    return c.json(await googleService.disconnect());
  } catch (error) {
    return googleErrorResponse(c, error);
  }
});

app.post("/api/google/verify", async (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  try {
    return c.json(await googleService.verify());
  } catch (error) {
    return googleErrorResponse(c, error);
  }
});

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function googleResultPage(title: string, detail: string, status: number): Response {
  const html =
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>${escapeHtml(title)}</title>` +
    `<body style="font:16px system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem">` +
    `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>` +
    `<p><a href="/">Back to the app</a> — Settings → Google shows what agents can do.</p>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...hardened },
  });
}

// Google's redirect back. Deliberately not gated on the session: with a
// GOOGLE_OAUTH_REDIRECT_URI override (local testing via localhost) the browser
// arrives on another origin without our cookie. The single-use `state` minted
// by the gated /connect is what authorises it.
app.get("/api/google/oauth/callback", async (c) => {
  try {
    const { email } = await googleService.finishConnect({
      state: c.req.query("state"),
      code: c.req.query("code"),
      error: c.req.query("error"),
    });
    return googleResultPage("Google connected", `Agents now act as ${email}.`, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return googleResultPage("Google was not connected", detail, 400);
  }
});

// Failed turns for one conversation, which the transcript cannot reload on its
// own: the app-server never stores them. See `session/turn-errors.ts`.
app.get("/api/turn-errors", (c) => {
  if (!c.get("session")) return c.text("Unauthorized", 401);
  const agentId = c.req.query("agent_id");
  const conversationId = c.req.query("conversation_id");
  if (!agentId || !conversationId) return c.text("Missing agent_id or conversation_id", 400);
  return c.json({ errors: turnErrors.list(scopeKeyOf(agentId, conversationId)) });
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

// ── WebSocket ────────────────────────────────────────────────────────────────
interface SocketData {
  /** Null for an upgrade accepted only to be told it is signed out; see `/ws`. */
  user: SessionUser | null;
  sessionId: string;
}

/**
 * Close code for "signed out". A refused upgrade (401) reaches the browser as
 * a bare 1006, indistinguishable from being offline, so the client retried
 * forever; a close code after the handshake is the one signal it can read.
 */
const AUTH_REQUIRED_CLOSE_CODE = 4401;

// PUBLIC_ORIGIN is only a declaration of intent; the bind address is the
// enforcement. The bypass stays on loopback unless DEV_BYPASS_ALLOW_REMOTE
// explicitly says otherwise, so it cannot reach the network by accident.
const bindHostname =
  config.devBypassEmail && !config.devBypassAllowRemote ? "127.0.0.1" : "0.0.0.0";

const server = Bun.serve<SocketData>({
  port: config.port,
  hostname: bindHostname,

  async fetch(request, bunServer) {
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

      // Signed out is accepted and then closed with AUTH_REQUIRED_CLOSE_CODE
      // (see `open` below), so the client can tell it apart from offline. A
      // session minted from the Access JWT rides back on the 101's cookie.
      const resolved = await resolveSession(request, sessionDeps);
      // The authenticated identity rides along in `data`, so the socket never
      // has to re-derive it from cookies after the upgrade.
      const upgraded = bunServer.upgrade(request, {
        ...(resolved?.setCookie ? { headers: { "set-cookie": resolved.setCookie } } : {}),
        data: {
          user: resolved ? { email: resolved.session.email } : null,
          sessionId: "",
        } satisfies SocketData,
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400, headers: hardened });
    }

    // The web-tools mod's calls: loopback only, before Hono's session layer.
    const internal = await handleInternalWebTools(
      request,
      bunServer.requestIP(request)?.address,
      webToolsBackends,
    );
    if (internal) return internal;

    return app.fetch(request);
  },

  websocket: {
    open(ws: ServerWebSocket<SocketData>) {
      if (!ws.data.user) {
        ws.send(JSON.stringify({ type: "__bff_auth_required" }));
        ws.close(AUTH_REQUIRED_CLOSE_CODE, "Authentication required");
        return;
      }
      ws.data.sessionId = registry.add(
        {
          send: (data) => ws.send(data),
          close: (code, reason) => ws.close(code, reason),
        },
        ws.data.user,
      );
    },

    message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
      if (!ws.data.sessionId) return;
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

// Closing the upstream connection cancels every turn in flight (it is the only
// subscriber of every scope), so shutdown first drains: browsers keep being
// served and the connection stays open until no turn is running, bounded by
// SHUTDOWN_DRAIN_TIMEOUT_SECONDS. A second signal skips the wait.
let shuttingDown = false;
let secondSignal: () => void = () => {};
const interrupted = new Promise<void>((resolve) => {
  secondSignal = resolve;
});

async function shutdown(signal: string): Promise<void> {
  log(`Received ${signal}, shutting down`);
  await drainActiveTurns({
    activeScopes: () => (upstream.isReady() ? registry.activeScopes() : []),
    timeoutMs: config.shutdownDrainTimeoutMs,
    log,
    interrupted,
  });
  upstream.stop();
  await server.stop(true);
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      log(`Received ${signal} again, not waiting any longer`);
      secondSignal();
      return;
    }
    shuttingDown = true;
    void shutdown(signal);
  });
}
