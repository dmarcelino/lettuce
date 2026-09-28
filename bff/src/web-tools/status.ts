/**
 * Settings → Web's status line: are the backends answering, and did the
 * app-server load the mod without errors.
 */

import { ddgReachable } from "./ddg.ts";
import { WEB_TOOLS_MOD_PATH } from "./mod.ts";

/** letta-code's mod diagnostics (`src/mods/mod-diagnostics-file.ts`): errors only, no successes. */
export const MOD_DIAGNOSTICS_PATH = "/root/.letta/mods/diagnostics/latest.json";

export interface WebToolsStatus {
  searxng: "up" | "down" | "off";
  ddg: "up" | "down" | "off";
  /** The mod's own load/run errors from the last diagnostics report, newest last. */
  modErrors: string[];
  modInstalled: boolean;
}

async function searxngUp(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/healthz", baseUrl), {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The mod's entries in the diagnostics report. Exported for tests. */
export function modErrorsFrom(diagnostics: string | null): string[] {
  if (!diagnostics) return [];
  try {
    const parsed = JSON.parse(diagnostics) as {
      report?: {
        diagnostics?: { mod?: string; phase?: string; message?: string; severity?: string }[];
      };
    };
    const name = WEB_TOOLS_MOD_PATH.slice(WEB_TOOLS_MOD_PATH.lastIndexOf("/") + 1);
    return (parsed.report?.diagnostics ?? [])
      .filter((d) => d.severity !== "warning" && (d.mod ?? "").includes(name.replace(/\.mjs$/, "")))
      .map((d) => `${d.phase ?? "error"}: ${d.message ?? "unknown error"}`);
  } catch {
    return [];
  }
}

export async function webToolsStatus(options: {
  searxngUrl: string | null;
  ddgMcpUrl: string | null;
  read: (path: string) => Promise<string | null>;
}): Promise<WebToolsStatus> {
  const [searxng, ddg, mod, diagnostics] = await Promise.all([
    options.searxngUrl ? searxngUp(options.searxngUrl) : Promise.resolve(null),
    options.ddgMcpUrl ? ddgReachable(options.ddgMcpUrl) : Promise.resolve(null),
    options.read(WEB_TOOLS_MOD_PATH).catch(() => null),
    options.read(MOD_DIAGNOSTICS_PATH).catch(() => null),
  ]);
  return {
    searxng: searxng === null ? "off" : searxng ? "up" : "down",
    ddg: ddg === null ? "off" : ddg ? "up" : "down",
    modErrors: modErrorsFrom(diagnostics),
    modInstalled: mod !== null,
  };
}
