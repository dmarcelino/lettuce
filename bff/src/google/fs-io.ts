/**
 * `GoogleIo` over the BFF's own mounts of the two Google volumes. Unlike the
 * Codex and MCP files these are NOT reached through the app-server: the whole
 * point is that the app-server — where agent shells run — cannot see them.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { GoogleIo } from "./service.ts";

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Names come from this module's callers, never a browser; refuse anything path-like anyway. */
function inside(dir: string, name: string): string {
  if (!name || basename(name) !== name || name.startsWith(".")) {
    throw new Error(`Refusing file name ${JSON.stringify(name)}`);
  }
  return join(dir, name);
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Write beside, then rename: the sidecar polls these files and must never read half of one. */
async function writeAtomic(dir: string, name: string, content: string, mode: number) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = inside(dir, name);
  const temp = join(dir, `.${name}.${process.pid}.tmp`);
  await writeFile(temp, content, { mode });
  await rename(temp, target);
}

export function createGoogleFsIo(policyDir: string, credsDir: string): GoogleIo {
  return {
    readPolicy: (name) => readOrNull(inside(policyDir, name)),
    // The sidecar reads these as another container's root: readable, not secret
    // beyond the volume itself (the client secret is in here, and the volume is
    // mounted nowhere an agent runs).
    writePolicy: (name, content) => writeAtomic(policyDir, name, content, 0o600),
    async listCreds() {
      try {
        return (await readdir(credsDir)).filter((name) => !name.startsWith("."));
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
    },
    readCred: (name) => readOrNull(inside(credsDir, name)),
    writeCred: (name, content) => writeAtomic(credsDir, name, content, 0o600),
    async deleteCred(name) {
      await rm(inside(credsDir, name), { force: true });
    },
  };
}
