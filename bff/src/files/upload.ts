/**
 * Putting a real file (a photo, a PDF) into an agent's workspace.
 *
 * `GET /api/files/download` gets a file out; this is the way in. The browser
 * POSTs raw bytes and one `write_file {encoding:"base64"}` writes them — the
 * base64 form of `write_file` (letta-code 0.34.16) bypasses the text Edit path,
 * creates parent directories, and answers with `bytes_written`. `append` and
 * `move_to` are deliberately not used: they exist for chunked writers, and a
 * 25 MB cap needs no chunking. At this size the frame also stays well inside the
 * app-server's own 100 MiB `ws` payload limit, and a single write is a single
 * frame on the one upstream connection.
 *
 * **The app-server applies no workspace root to a base64 write** — only
 * `write_file.path` is clamped in `session/protocol.ts`, and nothing clamps
 * `move_to`, which is one more reason not to send it. So the whole guard chain
 * lives here: session, lexical clamp, plain-filename rule, the symlink walk,
 * the size cap, and an in-flight cap.
 *
 * Like `git/routes.ts`, the handlers are plain functions (deps in,
 * `{status, json|text}` out) so the ordering is testable without a Hono app or
 * a live upstream. `index.ts` mounts them.
 */

import { lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  normalizePosixPath,
  WORKSPACE_ROOT,
  workspaceViolation,
} from "../session/protocol.ts";
import { type Lstat, symlinkViolation } from "../session/symlink-guard.ts";

/**
 * What one upload may weigh, raw. Symmetric with the download cap: the BFF holds
 * the bytes and their base64 form (1.33×) while the write is in flight, and this
 * is the process that owns the only upstream connection — an OOM here cancels
 * every turn in flight, with no drain to save them.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Two at a time, for the same reason the download route caps itself at 4. */
export const MAX_UPLOADS_IN_FLIGHT = 2;
/** Longest accepted filename, in bytes (a filesystem's own limit). */
const MAX_NAME_BYTES = 255;

/** The refusal, or null when this path may be written. */
export function uploadViolation(
  path: string | undefined,
  deps: { lstat?: Lstat } = {},
): string | null {
  if (!path) return "Missing path";
  // The existing lexical clamp: absolute, no traversal, under /work. A `~/`
  // path — which upstream's base64 writer accepts — is refused here, so a
  // browser never learns that form exists.
  const clamp = workspaceViolation({ type: "write_file", path });
  if (clamp) return clamp;
  const resolved = normalizePosixPath(path);
  if (!isPlainFileName(resolved.slice(resolved.lastIndexOf("/") + 1))) {
    return `${resolved} must end in a plain filename`;
  }
  // A symlink would write through to wherever it points; an absent tail is fine,
  // because this is a new file and the base64 writer creates parents.
  return symlinkViolation(resolved, WORKSPACE_ROOT, deps.lstat ?? lstatSync);
}

/** Why this body must be refused before it is read, or null when it may be read. */
export function declaredSizeViolation(contentLength: string | null): string | null {
  const declared = Number(contentLength);
  // A chunked request has no header; `NaN` fails the comparison and the actual
  // byte count is checked while reading instead.
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return `File is too large to upload (${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB max)`;
  }
  return null;
}

/**
 * The body, or null when it exceeded the cap. Read chunk-wise on purpose:
 * `arrayBuffer()` would buffer an over-long body whole before anyone could
 * object, and the cap is the point.
 */
export async function readUploadBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let next = await reader.read();
  while (!next.done) {
    const value = next.value;
    total += value.byteLength;
    if (total > MAX_UPLOAD_BYTES) {
      // Stop pulling and say so; the client keeps its file, not our heap.
      await reader.cancel();
      return null;
    }
    chunks.push(value);
    next = await reader.read();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export interface UploadReply {
  success?: boolean;
  error?: string;
  path?: string;
  bytes_written?: number;
}

export type UploadRequest = (
  frame: Record<string, unknown> & { type: string; request_id: string },
) => Promise<UploadReply>;

export interface UploadResult {
  status: number;
  json?: unknown;
  text?: string;
}

let inFlight = 0;

/** Write `bytes` to `path` through the app-server. Assumes the path already passed `uploadViolation`. */
export async function putWorkspaceFile(
  path: string,
  bytes: Uint8Array,
  request: UploadRequest,
): Promise<UploadResult> {
  if (inFlight >= MAX_UPLOADS_IN_FLIGHT) {
    return { status: 503, text: "Too many uploads at once" };
  }
  inFlight += 1;
  try {
    const reply = await request({
      type: "write_file",
      // Already normalized by `uploadViolation`; the app-server resolves it the
      // same way, and `~/` never reaches this function.
      path: normalizePosixPath(path),
      content: Buffer.from(bytes).toString("base64"),
      encoding: "base64",
      request_id: `bff-upload-${randomUUID()}`,
    });
    if (reply?.success !== true) {
      return { status: 502, text: reply?.error ?? "Failed to write file" };
    }
    // Upstream counts the decoded bytes it put on disk. A mismatch means the
    // file on disk is not the file the browser sent, which is the one thing
    // this route is promised to prevent.
    if (typeof reply.bytes_written === "number" && reply.bytes_written !== bytes.length) {
      return {
        status: 502,
        text: `Wrote ${reply.bytes_written} of ${bytes.length} bytes`,
      };
    }
    return {
      status: 200,
      json: { path: reply.path ?? normalizePosixPath(path), bytes: bytes.length },
    };
  } catch (error) {
    return {
      status: 502,
      text: error instanceof Error ? error.message : "Failed to write file",
    };
  } finally {
    inFlight -= 1;
  }
}

/** A name a workspace file may actually have: no separators, no control characters. */
function isPlainFileName(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what a filename must not hold — a NUL truncates the path at the syscall, and the rest smuggle terminal escapes into a listing.
  return !/[\u0000-\u001f\u007f/\\]/.test(name);
}
