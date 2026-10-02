import { describe, expect, test } from "bun:test";
import { NOT_A_REPOSITORY_STDERR } from "./log.ts";
import {
  checkGitAvailability,
  type GitChild,
  type GitSpawn,
  MAX_INFLIGHT,
  makeRunner,
} from "./service.ts";

const encoder = new TextEncoder();

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function childFor(options: { stdout?: string; stderr?: string; code?: number }): GitChild {
  return {
    stdout: streamFrom(options.stdout ?? ""),
    stderr: streamFrom(options.stderr ?? ""),
    kill: () => {},
    exited: Promise.resolve(options.code ?? 0),
  };
}

/**
 * A child that produces nothing and stays running until killed. `stderr`
 * stays null on purpose: an open stream that nobody reads would keep
 * `runUncapped` waiting for it even after the kill.
 */
function stalledChild(): GitChild {
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  let close: () => void = () => {};
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => controller.close();
    },
  });
  return {
    stdout,
    stderr: null,
    kill: () => {
      close();
      resolveExited(137);
    },
    exited,
  };
}

function spawning(handler: (cmdline: string[]) => GitChild): {
  spawn: GitSpawn;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    spawn: (cmdline) => {
      calls.push(cmdline);
      return handler(cmdline);
    },
  };
}

describe("runGit", () => {
  test("a successful run returns stdout and the argv it spawned", async () => {
    const fake = spawning(() => childFor({ stdout: "hello\n" }));
    const result = await makeRunner(fake.spawn)("/work/one", ["status"]);
    expect(result).toEqual({ ok: true, stdout: "hello\n" });
    expect(fake.calls[0]?.[0]).toBe("git");
    expect(fake.calls[0]).toContain("status");
  });

  test("no shell is ever involved: arguments with shell syntax stay single argv elements", async () => {
    const fake = spawning(() => childFor({ stdout: "x" }));
    await makeRunner(fake.spawn)("/work/a b; rm -rf /", [
      "log",
      "--pretty=format:%H %an ; echo $HOME `id` | tee -",
      "--end-of-options",
      "--",
      "weird && $(path)",
    ]);
    const cmdline = fake.calls[0] ?? [];
    expect(cmdline).toContain("/work/a b; rm -rf /");
    expect(cmdline).toContain("--pretty=format:%H %an ; echo $HOME `id` | tee -");
    expect(cmdline).toContain("weird && $(path)");
    expect(cmdline).not.toContain("sh");
    expect(cmdline).not.toContain("bash");
    expect(cmdline.every((part) => typeof part === "string")).toBe(true);
  });

  test("a stalled run is killed and classified as timed-out", async () => {
    const runner = makeRunner(() => stalledChild());
    const result = await runner("/work/one", ["log"], { timeoutMs: 30 });
    expect(!result.ok && result.error.kind).toBe("timed-out");
  });

  test("oversized output kills the child and is classified, not buffered", async () => {
    const runner = makeRunner(() => childFor({ stdout: "x".repeat(4096), code: 0 }));
    const result = await runner("/work/one", ["log"], { maxBytes: 100 });
    expect(!result.ok && result.error.kind).toBe("output-too-large");
  });

  test("a missing git binary is git-unavailable, not a crash", async () => {
    const runner = makeRunner(() => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    });
    const result = await runner("/work/one", ["status"]);
    expect(!result.ok && result.error.kind).toBe("git-unavailable");
  });

  test("git's refusal becomes a classification, not a stack", async () => {
    const runner = makeRunner(() =>
      childFor({ code: 128, stderr: `${NOT_A_REPOSITORY_STDERR}\n` }),
    );
    const result = await runner("/work/one", ["rev-parse", "--git-dir"]);
    expect(!result.ok && result.error.kind).toBe("not-a-repository");
  });

  test("the in-flight cap answers busy instead of piling up children", async () => {
    const pending: Promise<unknown>[] = [];
    try {
      for (let i = 0; i < MAX_INFLIGHT; i++) {
        pending.push(makeRunner(() => stalledChild())("/", ["log"], { timeoutMs: 60 }));
      }
      // The cap is process-wide on purpose: it is the total git children this
      // container may hold, not per caller. The fifth runner would spawn a
      // child if the cap let it through — that must not happen.
      const fifth = await makeRunner(() => childFor({ stdout: "must not spawn" }))("/", ["log"]);
      expect(!fifth.ok && fifth.error.kind).toBe("busy");
    } finally {
      await Promise.all(pending);
    }
    // Released once the held runs finished.
    const result = await makeRunner(() => childFor({ stdout: "ok\n" }))("/", ["log"]);
    expect(result.ok).toBe(true);
  });
});

describe("checkGitAvailability", () => {
  test("logs what it found, loudly when the image lacks git", async () => {
    const lines: string[] = [];
    const log = (message: string): void => {
      lines.push(message);
    };
    expect(
      await checkGitAvailability(async () => ({ ok: true, stdout: "git version 2.39.5\n" }), log),
    ).toBe(true);
    expect(lines).toEqual(["git available: git version 2.39.5"]);
    expect(
      await checkGitAvailability(
        async () => ({ ok: false, error: { kind: "git-unavailable" as const, detail: "x" } }),
        log,
      ),
    ).toBe(false);
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("NOT available");
  });
});
