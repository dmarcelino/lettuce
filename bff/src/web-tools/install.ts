/**
 * Keeping the web-tools mod on disk and loaded, and the settings behind it.
 *
 * letta-code loads global mods once, on the first client connection, and
 * again only on the `reload` command — it does not watch the directory. So on
 * every upstream connect the BFF renders the mod, and only when the file on
 * disk differs does it write it and ask for a reload. An app-server restart
 * needs neither: the file is already there when the BFF's connection, the
 * first one, triggers the load.
 */

import { loadMcpServers, type McpIo, saveMcpServers } from "../mcp/service.ts";
import { renderWebToolsMod, WEB_TOOLS_MOD_PATH } from "./mod.ts";
import {
  applyWebToolsSettingsUpdate,
  parseStoredWebToolsSettings,
  renderStoredWebToolsSettings,
  WEB_TOOLS_SETTINGS_PATH,
  type WebToolsSettings,
} from "./settings.ts";

export interface WebToolsIo {
  /** File contents, or null when the file does not exist. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  /**
   * Ask the app-server to reload its mods (`execute_command reload`). The
   * command needs an agent runtime, so this is false while no agent exists yet.
   */
  reloadMods(): Promise<boolean>;
}

export type ModSyncResult = "unchanged" | "reloaded" | "reload-pending";

export async function loadWebToolsSettings(
  io: Pick<WebToolsIo, "read">,
): Promise<WebToolsSettings> {
  return parseStoredWebToolsSettings(await io.read(WEB_TOOLS_SETTINGS_PATH));
}

/**
 * Write the mod if it differs from what is on disk, then reload. A reload that
 * could not run (no agent yet) is reported, so the caller can retry it.
 */
export async function syncWebToolsMod(
  io: WebToolsIo,
  options: { enabled: boolean; port: number },
): Promise<ModSyncResult> {
  const wanted = renderWebToolsMod(options);
  const current = await io.read(WEB_TOOLS_MOD_PATH);
  if (current === wanted) return "unchanged";
  await io.write(WEB_TOOLS_MOD_PATH, wanted);
  return (await io.reloadMods()) ? "reloaded" : "reload-pending";
}

/** A browser update: save the switch, then bring the mod in line with it. */
export async function saveWebToolsSettings(
  io: WebToolsIo,
  body: unknown,
  port: number,
): Promise<{ settings: WebToolsSettings; mod: ModSyncResult }> {
  const settings = applyWebToolsSettingsUpdate(await loadWebToolsSettings(io), body);
  await io.write(WEB_TOOLS_SETTINGS_PATH, renderStoredWebToolsSettings(settings));
  return { settings, mod: await syncWebToolsMod(io, { enabled: settings.enabled, port }) };
}

/** The entry this repo used to seed into the shared MCP list. */
function isSeededDdg(server: { name: string; url?: string }): boolean {
  return server.name === "duckduckgo" && /^https?:\/\/ddg-mcp:8000\/mcp\/?$/.test(server.url ?? "");
}

/**
 * Once per install: take the seeded duckduckgo server out of the shared MCP
 * list, now that `web_search`/`fetch_webpage` are native tools. Recorded in the
 * web-tools settings, so a user who adds it back afterwards keeps it.
 */
export async function retireSeededDdgMcp(io: WebToolsIo, mcp: McpIo): Promise<boolean> {
  const settings = await loadWebToolsSettings(io);
  if (settings.mcpDdgRetired) return false;
  const servers = await loadMcpServers(mcp);
  const kept = servers.filter((server) => !isSeededDdg(server));
  if (kept.length !== servers.length) await saveMcpServers(mcp, kept);
  await io.write(
    WEB_TOOLS_SETTINGS_PATH,
    renderStoredWebToolsSettings({ ...settings, mcpDdgRetired: true }),
  );
  return kept.length !== servers.length;
}
