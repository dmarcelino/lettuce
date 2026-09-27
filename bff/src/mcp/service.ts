import {
  defaultMcpServers,
  MCP_SETTINGS_PATH,
  type McpServer,
  readMcpServers,
  renderMcpSettings,
} from "./settings.ts";
import { MCP_SKILL_DIR, MCP_SKILL_NAME, renderMcpSkill } from "./skill.ts";

/**
 * Everything the MCP store touches, all of it through the app-server — the
 * files live on its letta-home bind mount, not in the BFF's container.
 */
export interface McpIo {
  /** File content, or null when it does not exist. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  /** `skill_enable`: symlink a skill directory into the global skills dir. */
  enableSkill(path: string): Promise<void>;
  /** `skill_disable`: unlink it again. "Not found" is success. */
  disableSkill(name: string): Promise<void>;
}

/** The configured servers. A missing file reads as an empty list. */
export async function loadMcpServers(io: McpIo): Promise<McpServer[]> {
  const raw = await io.read(MCP_SETTINGS_PATH);
  return raw === null ? [] : readMcpServers(raw);
}

/** Write the list, then bring the skill in line with it. */
export async function saveMcpServers(io: McpIo, servers: McpServer[]): Promise<void> {
  await io.write(MCP_SETTINGS_PATH, renderMcpSettings(servers));
  await syncMcpSkill(io, servers);
}

/**
 * Run on every upstream connect: create the settings file with the default
 * servers on a fresh install, and re-render the skill either way, so a deploy
 * always leaves the current wrapper and wording in place.
 *
 * Returns the servers now configured.
 */
export async function ensureMcpServers(io: McpIo, seedUrl: string | null): Promise<McpServer[]> {
  const raw = await io.read(MCP_SETTINGS_PATH);
  if (raw === null) {
    const servers = defaultMcpServers(seedUrl);
    await saveMcpServers(io, servers);
    return servers;
  }
  const servers = readMcpServers(raw);
  await syncMcpSkill(io, servers);
  return servers;
}

async function syncMcpSkill(io: McpIo, servers: McpServer[]): Promise<void> {
  if (servers.length === 0) {
    await io.disableSkill(MCP_SKILL_NAME);
    return;
  }
  const parent = MCP_SKILL_DIR.slice(0, MCP_SKILL_DIR.lastIndexOf("/"));
  for (const file of renderMcpSkill(servers)) {
    await io.write(`${parent}/${file.path}`, file.content);
  }
  await io.enableSkill(MCP_SKILL_DIR);
}
