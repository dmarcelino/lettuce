/**
 * Reading and writing a BFF-owned file whose name changed.
 *
 * The `letta-ui` → `lettuce` rename moved three settings files that another
 * process reads: Codex's and Claude Code's switch (`lettuce.json` beside their
 * config, read by the shims in docker/codex) and the Settings → Web search
 * switch. Those shims are baked into the app-server image, and that image is
 * only rebuilt when letta-code is bumped — so a new BFF can be talking to an
 * old shim that only knows the old name, and a rolled-back BFF can be talking
 * to a new one that only knows the new. Reading prefers the new name and falls
 * back to the old; writing mirrors to the old so the older reader never finds
 * the switch missing.
 *
 * Both halves are temporary by design: once the pinned app-server image is
 * built from a commit that renamed the files, the fallback and the mirror can
 * be deleted along with the `*_LEGACY_PATH` constants.
 */

export interface FileRead {
  /** File contents, or null when the file does not exist. */
  read(path: string): Promise<string | null>;
}

export interface MinimalFileIo extends FileRead {
  write(path: string, content: string): Promise<void>;
}

/** The contents of `path`, or of `legacy` when only the pre-rename file exists. */
export async function readRenamed(
  io: FileRead,
  path: string,
  legacy: string,
): Promise<string | null> {
  const current = await io.read(path);
  return current !== null ? current : io.read(legacy);
}

/** Write `path`, and mirror the same bytes to the pre-rename name. */
export async function writeRenamed(
  io: MinimalFileIo,
  path: string,
  legacy: string,
  content: string,
): Promise<void> {
  await io.write(path, content);
  await io.write(legacy, content);
}
