/**
 * Keeping the BFF's mods on disk and loaded.
 *
 * letta-code loads global mods once, on the first client connection, and
 * again only on the `reload` command — it does not watch the directory. So
 * the BFF renders every mod, writes only the ones that differ from disk, and
 * sends one `reload` for the batch. An app-server restart needs neither: the
 * files are already there when the BFF's connection, the first, loads them.
 *
 * A renamed mod is handled in the same batch: its old file is overwritten with
 * an inert stub (`RETIRED_MOD_SOURCE`), because the protocol cannot delete.
 */

export interface ModsIo {
  /** File contents, or null when the file does not exist. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  /**
   * `execute_command reload`. It needs an agent runtime, so this is false
   * while no agent exists yet.
   */
  reloadMods(): Promise<boolean>;
}

export interface RenderedMod {
  path: string;
  source: string;
}

export type ModSyncResult = "unchanged" | "reloaded" | "reload-pending";

/**
 * What we write over a mod file that is no longer ours to use.
 *
 * The protocol has no delete — the BFF can write a file through the upstream
 * connection and nothing else — so a renamed mod's old file stays in
 * `/root/.letta/mods` forever unless something overwrites it, and the old file
 * still registers its tools on load. Upstream's contract is a mod whose
 * default export (or `activate`) is a function, so the inert form is the same
 * no-op `export default function activate() {}` the "registers nothing" renders
 * already emit. Deleting the stub by hand on the host is optional
 * housekeeping after this has run.
 */
export const RETIRED_MOD_SOURCE =
  `// Retired by the lettuce BFF: this mod was renamed; the live one lives\n` +
  `// next to this file. Registers nothing.\nexport default function activate() {}\n`;

/**
 * Overwrite every retired mod path with the inert stub, so a rename cannot
 * leave two mods registering the same tools.
 */
async function retireMods(io: ModsIo, retired: readonly string[]): Promise<boolean> {
  let changed = false;
  for (const path of retired) {
    const current = await io.read(path);
    if (current === null || current === RETIRED_MOD_SOURCE) continue;
    await io.write(path, RETIRED_MOD_SOURCE);
    changed = true;
  }
  return changed;
}

export async function syncMods(
  io: ModsIo,
  mods: readonly RenderedMod[],
  retired: readonly string[] = [],
): Promise<ModSyncResult> {
  let changed = await retireMods(io, retired);
  for (const mod of mods) {
    if ((await io.read(mod.path)) === mod.source) continue;
    await io.write(mod.path, mod.source);
    changed = true;
  }
  if (!changed) return "unchanged";
  return (await io.reloadMods()) ? "reloaded" : "reload-pending";
}
