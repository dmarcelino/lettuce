import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SkillEntry, SkillFs } from "./discovery.ts";

/**
 * The BFF's own read-only mounts of the app-server's state (see compose.yml).
 * Symlinks are resolved to their target's kind, as upstream's `findSkillFiles`
 * does — that is the whole reason these roots are not read over the protocol.
 */
export const hostSkillFs: SkillFs = {
  async list(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: SkillEntry[] = [];
    for (const entry of entries) {
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(join(dir, entry.name));
          isDir = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue; // dangling link — upstream reports it; nothing to list
        }
      }
      const linked = entry.isSymbolicLink();
      if (isDir) out.push({ name: entry.name, kind: "dir", linked });
      else if (isFile) out.push({ name: entry.name, kind: "file", linked });
    }
    return out;
  },
  read: (path) => readFile(path, "utf8"),
  realpath: (path) => realpath(path),
};

export interface UpstreamFileAccess {
  /** Folders and files directly in `dir`; null when it does not exist. */
  list(dir: string): Promise<{ folders: string[]; files: string[] } | null>;
  read(path: string): Promise<string>;
}

/**
 * Bundled skills live only inside the app-server image, so they are read over
 * the permanent connection. They are real directories, so the protocol's
 * habit of skipping symlinks costs nothing here.
 */
export function upstreamSkillFs(access: UpstreamFileAccess): SkillFs {
  return {
    async list(dir) {
      const listing = await access.list(dir);
      if (!listing) return null;
      return [
        ...listing.folders.map((name) => ({ name, kind: "dir" as const })),
        ...listing.files.map((name) => ({ name, kind: "file" as const })),
      ];
    },
    read: (path) => access.read(path),
    realpath: async (path) => path,
  };
}
