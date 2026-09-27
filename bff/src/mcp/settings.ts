/**
 * The shared MCP server list, and the settings file `letta mcp` reads it from.
 *
 * Upstream keeps MCP servers per agent in `/root/.letta/settings.json`, and
 * that file is unusable for us: the app-server holds it in memory and rewrites
 * the whole `agents` array from that copy whenever any agent setting changes
 * (agent create, pin, memfs, toolset, system-prompt versioning), which
 * silently dropped entries written from outside, and `reload` never re-reads
 * it. See CLAUDE.md.
 *
 * So the servers live in a settings file of their own, under a home directory
 * the app-server never loads: `letta mcp`, run from an agent's shell with
 * `HOME=MCP_HOME` (the `mcp-servers` skill's wrapper does that), reads it fresh
 * on every call. One synthetic agent id holds the list, which makes it global —
 * every agent passes the same `--agent`.
 *
 * The BFF owns this file outright, so it is rendered whole, never merged.
 */

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServer {
  name: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** `HOME` for `letta mcp` — under the letta-home bind mount, so it persists. */
export const MCP_HOME = "/root/.letta/mcp-home";
export const MCP_SETTINGS_PATH = `${MCP_HOME}/.letta/settings.json`;

/**
 * The agent id the list is stored under. Nothing checks that it exists
 * (`resolveMcpAgentId` takes the string as given); the `agent-local-` prefix
 * keeps it compatible with letta-code's local-mode id checks all the same.
 */
export const GLOBAL_MCP_AGENT = "agent-local-mcp-global";

/**
 * `getAgentSettings` matches `baseUrl` as well as `agentId`, and in local mode
 * the key is `local:<resolved LETTA_LOCAL_BACKEND_DIR>` — `/data/local-backend`
 * per docker/compose.yml, inherited by every agent shell. An entry without it
 * is invisible to `letta mcp`.
 */
export const LOCAL_BASE_URL = "local:/data/local-backend";

/** A settings file we cannot parse is not something to show or overwrite. */
export class SettingsUnreadableError extends Error {}

/** A payload we refuse to write. Surfaced to the caller as a 400. */
export class InvalidMcpServersError extends Error {}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

/**
 * Validate one server entry and normalise it for writing.
 *
 * Kept permissive about which optional fields are present — the transport
 * decides what is required, and a field the editor does not set is simply
 * omitted rather than written as an empty string. What it refuses is anything
 * that would produce a broken or surprising entry: a nameless server, an
 * unknown transport, a stdio server with no command, a remote server with no
 * URL, or non-string env/header values.
 */
function validateServer(value: unknown, index: number): McpServer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidMcpServersError(`Server ${index} is not an object`);
  }
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) throw new InvalidMcpServersError(`Server ${index} has no name`);

  const transport = (typeof raw.transport === "string" ? raw.transport : "stdio") as McpTransport;
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
    throw new InvalidMcpServersError(`Server "${name}" has an unknown transport: ${transport}`);
  }

  const server: McpServer = { name, transport };

  if (transport === "stdio") {
    const command = typeof raw.command === "string" ? raw.command.trim() : "";
    if (!command) throw new InvalidMcpServersError(`Server "${name}" has no command`);
    server.command = command;
    if (Array.isArray(raw.args)) {
      if (!raw.args.every((arg) => typeof arg === "string")) {
        throw new InvalidMcpServersError(`Server "${name}" has non-string arguments`);
      }
      server.args = raw.args as string[];
    }
  } else {
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!url) throw new InvalidMcpServersError(`Server "${name}" has no url`);
    server.url = url;
  }

  if (raw.env !== undefined) {
    if (!isStringRecord(raw.env)) {
      throw new InvalidMcpServersError(`Server "${name}" has non-string env values`);
    }
    server.env = raw.env;
  }
  if (raw.headers !== undefined) {
    if (!isStringRecord(raw.headers)) {
      throw new InvalidMcpServersError(`Server "${name}" has non-string header values`);
    }
    server.headers = raw.headers;
  }
  return server;
}

/** Validate a whole list and return normalised copies. */
export function validateMcpServers(value: unknown): McpServer[] {
  if (!Array.isArray(value)) throw new InvalidMcpServersError("servers must be an array");
  const servers = value.map(validateServer);
  const names = new Set<string>();
  for (const server of servers) {
    if (names.has(server.name)) {
      throw new InvalidMcpServersError(`Duplicate MCP server name: ${server.name}`);
    }
    names.add(server.name);
  }
  return servers;
}

/**
 * The whole settings file for `letta mcp`.
 *
 * `autoConversationTitlesRollbackApplied: true` is load-bearing: without it
 * `settingsManager.initialize()` runs a one-time migration and persists, so
 * every agent's `letta mcp` call would rewrite this file — racing the BFF's
 * own writes. With it set, the CLI only ever reads.
 */
export function renderMcpSettings(servers: McpServer[]): string {
  const settings = {
    autoConversationTitles: false,
    autoConversationTitlesRollbackApplied: true,
    agents: [{ agentId: GLOBAL_MCP_AGENT, baseUrl: LOCAL_BASE_URL, mcpServers: servers }],
  };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * The configured servers, as written.
 *
 * Returned unvalidated on purpose: refusing to DISPLAY a server that is on
 * disk would hide it rather than show it. Validation happens on write.
 */
export function readMcpServers(raw: string): McpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SettingsUnreadableError(
      `${MCP_SETTINGS_PATH} is not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsUnreadableError(`${MCP_SETTINGS_PATH} is not a JSON object`);
  }
  const agents = (parsed as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return [];
  const entry = agents.find(
    (agent) =>
      Boolean(agent) &&
      typeof agent === "object" &&
      (agent as { agentId?: unknown }).agentId === GLOBAL_MCP_AGENT,
  ) as { mcpServers?: unknown } | undefined;
  if (!Array.isArray(entry?.mcpServers)) return [];
  return entry.mcpServers.filter(
    (server): server is McpServer => Boolean(server) && typeof server === "object",
  );
}

/**
 * What a fresh install starts with: the bundled DuckDuckGo sidecar, when its
 * URL is configured. Only used when the settings file does not exist yet —
 * once it does, the list is the user's, so removing the server sticks.
 */
export function defaultMcpServers(seedUrl: string | null): McpServer[] {
  return seedUrl ? [{ name: "duckduckgo", transport: "http", url: seedUrl }] : [];
}
