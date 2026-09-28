/**
 * Keeping the BFF's mods on disk and loaded.
 *
 * letta-code loads global mods once, on the first client connection, and
 * again only on the `reload` command — it does not watch the directory. So
 * the BFF renders every mod, writes only the ones that differ from disk, and
 * sends one `reload` for the batch. An app-server restart needs neither: the
 * files are already there when the BFF's connection, the first, loads them.
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

export async function syncMods(io: ModsIo, mods: readonly RenderedMod[]): Promise<ModSyncResult> {
  let changed = false;
  for (const mod of mods) {
    if ((await io.read(mod.path)) === mod.source) continue;
    await io.write(mod.path, mod.source);
    changed = true;
  }
  if (!changed) return "unchanged";
  return (await io.reloadMods()) ? "reloaded" : "reload-pending";
}
