/**
 * The MCP settings merge, done server-side.
 *
 * MCP servers are absent from the app-server protocol: they live in
 * `/root/.letta/settings.json` under the agent's own entry (see CLAUDE.md).
 * The MCP editor used to read that file and write it back from the browser,
 * which meant the browser needed `write_file` on a file whose `mcpServers`
 * entries are arbitrary command lines the app-server execs as root. The
 * browser may read the file; the write happens here instead, so the merge is
 * performed against the file as it is right now rather than a copy the client
 * read earlier, and the browser never gets a write handle on it at all.
 *
 * Merge, never replace: the file holds ~18 unrelated top-level settings
 * including `deviceId`, and the `agents` array holds entries for agents this
 * screen is not touching. Only the named agent's `mcpServers` changes.
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

/** A settings file we cannot parse is not something to merge into. */
export class SettingsUnreadableError extends Error {}

/** A payload we refuse to write. Surfaced to the caller as a 400. */
export class InvalidMcpServersError extends Error {}

function parseSettings(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SettingsUnreadableError(
      `settings.json is not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsUnreadableError("settings.json is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

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

/** The named agent's entry, or undefined when the file has none. */
function findAgent(
  settings: Record<string, unknown>,
  agentId: string,
): Record<string, unknown> | undefined {
  const agents = settings.agents;
  if (!Array.isArray(agents)) return undefined;
  for (const entry of agents) {
    if (
      entry &&
      typeof entry === "object" &&
      (entry as { agentId?: unknown }).agentId === agentId
    ) {
      return entry as Record<string, unknown>;
    }
  }
  return undefined;
}

/**
 * The agent's configured servers, as written.
 *
 * Returned unvalidated on purpose: this reads whatever an older editor version
 * or the CLI may have written, and refusing to DISPLAY a server the user did
 * not just add would hide it rather than show it. Validation happens on write.
 */
export function readMcpServers(settingsRaw: string, agentId: string): McpServer[] {
  const agent = findAgent(parseSettings(settingsRaw), agentId);
  const servers = agent?.mcpServers;
  if (!Array.isArray(servers)) return [];
  return servers.filter((entry): entry is McpServer => Boolean(entry) && typeof entry === "object");
}

/**
 * Merge `servers` into `agentId`'s entry and return the whole file to write.
 *
 * Every other top-level setting and every other agent entry is carried through
 * byte-for-byte in content (re-serialised, not textually patched). An empty
 * list removes the `mcpServers` key rather than writing `[]`, matching what
 * the editor did and keeping the file tidy.
 */
export function mergeMcpServers(
  settingsRaw: string,
  agentId: string,
  servers: McpServer[],
): string {
  const settings = parseSettings(settingsRaw);
  const agents = Array.isArray(settings.agents) ? [...(settings.agents as unknown[])] : [];
  const index = agents.findIndex(
    (entry) =>
      Boolean(entry) &&
      typeof entry === "object" &&
      (entry as { agentId?: unknown }).agentId === agentId,
  );

  if (index === -1) {
    if (servers.length === 0) {
      // Nothing to remove and nothing to add: hand back an identical file
      // rather than appending an empty agent entry.
      return settingsRaw;
    }
    agents.push({ agentId, mcpServers: servers });
  } else {
    const existing = { ...(agents[index] as Record<string, unknown>) };
    if (servers.length === 0) delete existing.mcpServers;
    else existing.mcpServers = servers;
    agents[index] = existing;
  }

  return `${JSON.stringify({ ...settings, agents }, null, 2)}\n`;
}
