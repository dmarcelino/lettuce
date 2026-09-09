import { statSync } from "node:fs";

/**
 * Augments `get_tree` entries with real modification times, read directly off
 * the BFF's own read-only mount of the workspace (`docker/compose.yml`).
 *
 * `get_tree` reports only `{path, type}` — no mtime, no size — and the fork
 * that owns the protocol cannot be patched (see CLAUDE.md's zero-fork-delta
 * rule). This never changes which entries are returned, only adds a field to
 * ones the app-server already decided to return, so it cannot show anything
 * `get_tree` itself would have filtered out (symlinks, `.lettaignore`
 * matches, etc.).
 *
 * A stat failure (file removed between the list and this call) just omits
 * `modified` for that entry rather than failing the whole response.
 */
export function withModifiedTimes<T extends { path: string }>(
  root: string,
  entries: T[],
): (T & { modified?: number })[] {
  return entries.map((entry) => {
    try {
      const stats = statSync(resolveEntryPath(root, entry.path));
      return { ...entry, modified: stats.mtimeMs };
    } catch {
      return entry;
    }
  });
}

/**
 * `get_tree` reports paths relative to the root it was given (see
 * `web/src/tabs/FilesTab.tsx`'s own `resolve()`, which this mirrors) — every
 * other file command wants absolute, so the client and this join the same way.
 */
function resolveEntryPath(root: string, relative: string): string {
  if (relative.startsWith("/")) return relative;
  const base = root === "/" ? "" : root.replace(/\/+$/, "");
  return `${base}/${relative}`.replace(/\/{2,}/g, "/");
}
