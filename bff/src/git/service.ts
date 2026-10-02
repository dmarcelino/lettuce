/**
 * Running git. One spawn path, argv-only — never a shell string, so a path or
 * a sha can never become syntax. Failure is always a classification from
 * `log.ts`, never a thrown stack: an agent-authored repository is expected to
 * be weird, and a weird repository is a sheet message, not a 500.
 *
 * The environment is minimal on purpose: `GIT_CONFIG_NOSYSTEM` keeps any
 * system gitconfig out of the picture, `GIT_TERMINAL_PROMPT=0` makes git fail
 * instead of waiting on a prompt that no one will answer, `GIT_CEILING_DIRECTORIES=/`
 * stops repository discovery from climbing out of the container's view of the
 * filesystem, and `HOME=/tmp` keeps git out of any real home directory.
 */

import {
  classifyGitFailure,
  type GitFailure,
  type GitResult,
  gitArgv,
  PROBE_BRANCH,
  PROBE_GIT_DIR,
  PROBE_TOPLEVEL,
  parseRepoProbe,
  type RepoProbe,
} from "./log.ts";

export interface RunGitOptions {
  /** The child is killed and the call reports `timed-out` after this. */
  timeoutMs?: number;
  /** Killing limit on stdout+stderr combined; exceeding it reports `output-too-large`. */
  maxBytes?: number;
}

/** The sliver of a child process this module needs; `service.test.ts` fakes exactly this. */
export interface GitChild {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  kill(): unknown;
  exited: Promise<number>;
}

export type GitSpawn = (cmdline: string[]) => GitChild;

export type GitRunner = (dir: string, args: string[], opts?: RunGitOptions) => Promise<GitResult>;

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** At most this many git children at once; a fifth caller is told to wait (429). */
export const MAX_INFLIGHT = 4;

let inflight = 0;

function gitEnv(): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CEILING_DIRECTORIES: "/",
    HOME: "/tmp",
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
}

const defaultSpawn: GitSpawn = (cmdline) => {
  const child = Bun.spawn(cmdline, {
    env: gitEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: child.stdout as ReadableStream<Uint8Array>,
    stderr: child.stderr as ReadableStream<Uint8Array>,
    kill: () => child.kill(),
    exited: child.exited,
  };
};

/** The process-wide runner the routes use. */
export const runGit: GitRunner = (dir, args, opts) => spawnRun(defaultSpawn, dir, args, opts);

/** A runner over a different spawn implementation — the seam `service.test.ts` uses. */
export function makeRunner(spawn: GitSpawn): GitRunner {
  return (dir, args, opts) => spawnRun(spawn, dir, args, opts);
}

async function spawnRun(
  spawn: GitSpawn,
  dir: string,
  args: string[],
  opts: RunGitOptions = {},
): Promise<GitResult> {
  if (inflight >= MAX_INFLIGHT) {
    return {
      ok: false,
      error: { kind: "busy", detail: `Already ${MAX_INFLIGHT} git commands are running.` },
    };
  }
  inflight++;
  try {
    return await runUncapped(spawn, dir, args, opts);
  } finally {
    inflight--;
  }
}

async function runUncapped(
  spawn: GitSpawn,
  dir: string,
  args: string[],
  opts: RunGitOptions,
): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let child: GitChild;
  try {
    child = spawn(gitArgv(dir, args));
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") {
      return {
        ok: false,
        error: {
          kind: "git-unavailable",
          detail: "The git binary is not installed in this image.",
        },
      };
    }
    return {
      ok: false,
      error: { kind: "failed", detail: `failed:${errorText(error)}` },
    };
  }

  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* the child is already gone */
      }
    },
    Math.max(1, timeoutMs),
  );

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout, maxBytes),
      readStream(child.stderr, 64 * 1024),
      child.exited,
    ]);

    if (timedOut) {
      return { ok: false, error: { kind: "timed-out", detail: "git timed out." } };
    }
    if (stdout.overflow || stderr.overflow) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      return { ok: false, error: { kind: "output-too-large", detail: "git output too large." } };
    }
    if (exitCode === 0) return { ok: true, stdout: stdout.text };
    return { ok: false, error: classifyGitFailure(stderr.text, exitCode) };
  } finally {
    clearTimeout(timer);
  }
}

interface StreamRead {
  text: string;
  overflow: boolean;
}

async function readStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<StreamRead> {
  if (!stream) return { text: "", overflow: false };
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
    if (total > maxBytes) {
      overflow = true;
      break;
    }
  }
  let text = "";
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  text += decoder.decode();
  return { text, overflow };
}

/** The three probes, then their fold into one repository answer. */
export async function probeRepo(runner: GitRunner, dir: string): Promise<RepoProbe> {
  const gitDir = await runner(dir, PROBE_GIT_DIR);
  if (!gitDir.ok) return { ok: false, failure: gitDir.error };
  const toplevel = await runner(dir, PROBE_TOPLEVEL);
  if (!toplevel.ok) return { ok: false, failure: toplevel.error };
  const branch = await runner(dir, PROBE_BRANCH);
  if (!branch.ok) return { ok: false, failure: branch.error };
  return parseRepoProbe({ gitDir, toplevel, branch });
}

/** One probe to answer "where is the root, if there is one" for the commit route. */
export async function probeRoot(runner: GitRunner, dir: string): Promise<GitResult> {
  return runner(dir, PROBE_TOPLEVEL);
}

/**
 * Boot-time `git --version`. The routes already answer 503 with
 * `git-unavailable` when the binary is missing; this only makes a misbuilt
 * image loud in the log once, instead of quietly on the first History open.
 */
export async function checkGitAvailability(
  runner: GitRunner = runGit,
  log: (message: string) => void = (message) => console.log(message),
): Promise<boolean> {
  const result = await runner("/", ["--version"]);
  if (result.ok) {
    log(`git available: ${result.stdout.trim()}`);
    return true;
  }
  if (result.error.kind === "git-unavailable") {
    log(
      "git is NOT available in this image — /api/git/* will answer 503. (bff.Dockerfile installs git.)",
    );
    return false;
  }
  return false;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { GitFailure };
