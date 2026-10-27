/**
 * Reading letta-code's mod diagnostics report: the one place a mod that failed
 * to import or activate says so. A `reload` answers success either way.
 */

import { MODS_DIR } from "./mod.ts";

/** letta-code's `mods/mod-diagnostics-file.ts`: the latest report, errors and warnings only. */
export const MOD_DIAGNOSTICS_PATH = `${MODS_DIR}/diagnostics/latest.json`;

export interface ModError {
  phase: string;
  message: string;
}

/**
 * The errors one mod file reported, oldest first. `since` (ms) ignores a report
 * written before the reload it is read for. Each entry's `mod` is the owner
 * object letta-code copies in (`mods/mod-diagnostics.ts`), matched on its path.
 */
export function modErrorsIn(raw: string | null, modPath: string, since = 0): ModError[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as {
      generatedAt?: number;
      report?: {
        diagnostics?: {
          mod?: { path?: string };
          phase?: string;
          message?: string;
          severity?: string;
        }[];
      };
    };
    if ((parsed.generatedAt ?? 0) < since) return [];
    return (parsed.report?.diagnostics ?? [])
      .filter((d) => d.severity !== "warning" && d.mod?.path === modPath)
      .map((d) => ({ phase: d.phase ?? "error", message: d.message ?? "unknown error" }));
  } catch {
    return [];
  }
}
