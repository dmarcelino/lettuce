import { describe, expect, test } from "bun:test";
import {
  declaredSizeViolation,
  MAX_UPLOAD_BYTES,
  putWorkspaceFile,
  readUploadBody,
  uploadViolation,
} from "./upload.ts";

// Production clamps against the container's /work, which is not on this
// machine, so the filesystem half of the guard runs on an injected `lstat`.
// The guard itself is exercised for real by `session/symlink-guard.test.ts`;
// what is under test here is that an upload consults it at all.
const absent = () => {
  throw Object.assign(new Error("no such file"), { code: "ENOENT" });
};
const ok = (path: string | undefined) => uploadViolation(path, { lstat: absent });

describe("uploadViolation", () => {
  test("accepts a new file anywhere under the root, parents included", () => {
    expect(ok("/work/notes/photo.jpg")).toBeNull();
    expect(ok("/work/brand/new/deep.pdf")).toBeNull();
    expect(ok("/work/a b(1).jpg")).toBeNull();
  });

  test("refuses a path the lexical clamp refuses", () => {
    expect(ok(undefined)).toBe("Missing path");
    expect(ok("")).toBe("Missing path");
    expect(ok("notes/photo.jpg")).toContain("absolute path");
    expect(ok("~/notes/photo.jpg")).toContain("absolute path");
    expect(ok("/etc/passwd")).toContain("outside the workspace");
    expect(ok("/work/notes/../../../etc/passwd")).toContain("outside the workspace");
  });

  test("refuses a name a file may not have", () => {
    expect(ok("/work/notes/a\u0000.jpg")).toContain("plain filename");
    expect(ok("/work/notes/a\nb.jpg")).toContain("plain filename");
    expect(ok(`/work/notes/${"x".repeat(300)}.jpg`)).toContain("plain filename");
  });

  test("refuses a symlink component, allows an absent tail", () => {
    const links = (path: string) => {
      if (path === "/work/link") return { isSymbolicLink: () => true };
      return absent();
    };
    expect(uploadViolation("/work/link/escape.txt", { lstat: links })).toContain("is a symlink");
    // The base64 writer creates parent directories, so a path that does not
    // exist yet is the normal case, not a violation.
    expect(ok("/work/not-here/yet/file.txt")).toBeNull();
  });
});

describe("size limits", () => {
  test("a declared content-length over the cap is refused before reading", () => {
    expect(declaredSizeViolation(null)).toBeNull();
    expect(declaredSizeViolation("10")).toBeNull();
    expect(declaredSizeViolation(String(MAX_UPLOAD_BYTES))).toBeNull();
    expect(declaredSizeViolation(String(MAX_UPLOAD_BYTES + 1))).toContain("too large");
  });

  test("the body is read whole when it fits", async () => {
    const bytes = await readUploadBody(streamOf(["hello ", "world"]));
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe("hello world");
    expect(await readUploadBody(null)).toEqual(new Uint8Array());
  });

  test("an undeclared body over the cap is refused while reading, not after", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const many = new ReadableStream<Uint8Array>({
      start(controller) {
        // More than the cap, in pieces, so only a reader that stops early
        // avoids buffering the whole thing.
        for (let i = 0; i < MAX_UPLOAD_BYTES / chunk.byteLength + 2; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    expect(await readUploadBody(many)).toBeNull();
  });
});

describe("putWorkspaceFile", () => {
  test("writes through one base64 write_file, with no chunking fields", async () => {
    const frames: Record<string, unknown>[] = [];
    const result = await putWorkspaceFile("/work/notes/photo.jpg", bytesOf("hi"), async (frame) => {
      frames.push(frame);
      return { success: true, path: "/work/notes/photo.jpg", bytes_written: 2 };
    });
    expect(result).toEqual({ status: 200, json: { path: "/work/notes/photo.jpg", bytes: 2 } });
    expect(frames).toHaveLength(1);
    const frame = frames[0] as Record<string, unknown>;
    expect(frame.type).toBe("write_file");
    expect(frame.path).toBe("/work/notes/photo.jpg");
    expect(frame.encoding).toBe("base64");
    expect(frame.content).toBe(Buffer.from("hi").toString("base64"));
    expect(String(frame.request_id).startsWith("bff-upload-")).toBe(true);
    // `append`/`move_to` are the unclamped second path field; sending neither
    // is what keeps that gap shut.
    expect("append" in frame).toBe(false);
    expect("move_to" in frame).toBe(false);
  });

  test("an upstream failure is a 502 with its message", async () => {
    const failed = await putWorkspaceFile("/work/notes/x", new Uint8Array(1), async () => ({
      success: false,
      error: "disk on fire",
    }));
    expect(failed).toEqual({ status: 502, text: "disk on fire" });
    const thrown = await putWorkspaceFile("/work/notes/x", new Uint8Array(1), async () => {
      throw new Error("upstream went away");
    });
    expect(thrown).toEqual({ status: 502, text: "upstream went away" });
  });

  test("a short write is refused, not reported as a success", async () => {
    const result = await putWorkspaceFile("/work/notes/x", bytesOf("hello"), async () => ({
      success: true,
      bytes_written: 3,
    }));
    expect(result.status).toBe(502);
    expect(result.text).toContain("3 of 5");
  });

  test("at most two uploads are in flight at once", async () => {
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: UploadRequestLike = async () => {
      await pending;
      return { success: true, bytes_written: 1 };
    };
    const first = putWorkspaceFile("/work/notes/a", new Uint8Array(1), slow);
    const second = putWorkspaceFile("/work/notes/b", new Uint8Array(1), slow);
    // Let the two tasks reach the upstream call before asking for a third.
    await Promise.resolve();
    const third = await putWorkspaceFile("/work/notes/c", new Uint8Array(1), async () => ({
      success: true,
    }));
    expect(third).toEqual({ status: 503, text: "Too many uploads at once" });
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    // The slots come back: a fourth upload after those two finish is allowed.
    expect(
      (
        await putWorkspaceFile("/work/notes/d", new Uint8Array(1), async () => ({
          success: true,
          bytes_written: 1,
        }))
      ).status,
    ).toBe(200);
  });
});

type UploadRequestLike = (frame: Record<string, unknown>) => Promise<{
  success?: boolean;
  bytes_written?: number;
}>;

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
