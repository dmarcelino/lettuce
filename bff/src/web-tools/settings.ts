/**
 * Settings → Web: the agents' native `web_search` / `fetch_webpage` tools.
 *
 * The tools are a letta-code mod (see `mod.ts`) that the BFF writes into the
 * app-server's global mods directory; this file is the switch the BFF renders
 * that mod from. It lives on letta-home next to Codex's, written over the
 * permanent upstream connection like every other file there.
 */

export const WEB_TOOLS_HOME = "/root/.letta/web-tools";
export const WEB_TOOLS_SETTINGS_PATH = `${WEB_TOOLS_HOME}/lettuce.json`;
/**
 * The name this file had before the `letta-ui` → `lettuce` rename, read when
 * the new one is absent so an existing install keeps its switch. Nothing but
 * the BFF ever reads it, so writes are not mirrored.
 */
export const WEB_TOOLS_SETTINGS_LEGACY_PATH = `${WEB_TOOLS_HOME}/letta-ui.json`;

export interface WebToolsSettings {
  /** Whether the mod registers the tools. On by default: web access is a baseline capability. */
  enabled: boolean;
  /**
   * The one-time removal of the duckduckgo entry from the shared MCP list has
   * run. Recorded so a user who re-adds that server keeps it.
   */
  mcpDdgRetired: boolean;
}

export const DEFAULT_WEB_TOOLS_SETTINGS: WebToolsSettings = {
  enabled: true,
  mcpDdgRetired: false,
};

export class InvalidWebToolsSettingsError extends Error {}

/** Lenient: a missing, hand-edited or older file still loads, with defaults filling the gaps. */
export function parseStoredWebToolsSettings(text: string | null): WebToolsSettings {
  if (!text) return { ...DEFAULT_WEB_TOOLS_SETTINGS };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...DEFAULT_WEB_TOOLS_SETTINGS };
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULT_WEB_TOOLS_SETTINGS };
  const record = raw as Record<string, unknown>;
  return {
    enabled:
      typeof record.enabled === "boolean" ? record.enabled : DEFAULT_WEB_TOOLS_SETTINGS.enabled,
    mcpDdgRetired: record.mcpDdgRetired === true,
  };
}

export function renderStoredWebToolsSettings(settings: WebToolsSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** A browser update: only `enabled` is the user's to change. Throws on anything malformed. */
export function applyWebToolsSettingsUpdate(
  current: WebToolsSettings,
  body: unknown,
): WebToolsSettings {
  if (!body || typeof body !== "object") {
    throw new InvalidWebToolsSettingsError("Expected a JSON object");
  }
  const { enabled } = body as Record<string, unknown>;
  if (typeof enabled !== "boolean") {
    throw new InvalidWebToolsSettingsError("`enabled` must be true or false");
  }
  return { ...current, enabled };
}
