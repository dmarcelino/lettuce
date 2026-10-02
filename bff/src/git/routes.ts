/**
 * The two session-gated HTTP routes behind Files → History. Both read a git
 * repository through the BFF's read-only `/work` mount because upstream
 * exposes only `search_branches` / `checkout_branch` and the app-server image
 * ships no git binary — so the log is read here, and nothing goes upstream.
 *
 * The handlers are plain functions (deps in, `{status, json|text}` out) so
 * the security-relevant ordering — session, lexical clamp, symlink guard,
 * realpath re-check, directory check, only then git — is testable without a
 * Hono app, a session, or git itself. `index.ts` mounts them verbatim.
 */

import { lstatSync, realpathSync, type Stats } from "node:fs";
import { normalizePosixPath, WORKSPACE_ROOT } from "../session/protocol.ts";
import { symlinkViolation } from "../session/symlink-guard.ts";
import {
  clampLimit,
  clampSkip,
  DEFAULT_LIMIT,
  type GitFailure,
  logArgs,
  parseLog,
  parseShow,
  pathspecFor,
  showArgs,
  validSha,
} from "./log.ts";
import { type GitRunner, probeRepo, probeRoot, runGit } from "./service.ts";

export interface GitRouteDeps {
  /** Whether the request carries a valid session; index.ts passes `!!c.get("session")`. */
  hasSession: boolean;
  /** Defaults to the process-wide runner; tests inject canned results. */
  runner?: GitRunner;
  /** Workspace root; only tests move it off `/work`. */
  root?: string;
  realpath?: (path: string) => string;
  lstat?: (path: string) => Stats;
}

export interface GitRouteResult {
  status: number;
  json?: unknown;
  text?: string;
}

export interface GitLogQuery {
  path?: string;
  limit?: string;
  skip?: string;
}

export interface GitCommitQuery {
  path?: string;
  sha?: string;
}

/** `GET /api/git/log?path=&limit=&skip=` — the commit log of the folder's repository. */
export async function gitLogResponse(
  deps: GitRouteDeps,
  query: GitLogQuery,
): Promise<GitRouteResult> {
  if (!deps.hasSession) return { status: 401, text: "Unauthorized" };

  const guard = guardDirectory(deps, query.path);
  if (!guard.ok) return guard.result;
  const dir = guard.real;

  const limit = clampLimit(query.limit, DEFAULT_LIMIT);
  if (limit === null) return { status: 400, text: "limit must be an integer between 1 and 200" };
  const skip = clampSkip(query.skip);
  if (skip === null) return { status: 400, text: "skip must be a non-negative integer" };

  const runner = deps.runner ?? runGit;
  const probe = await probeRepo(runner, dir);
  if (!probe.ok) {
    if (probe.failure.kind === "not-a-repository") {
      return { status: 200, json: { repo: false, reason: probe.failure.detail } };
    }
    return failureResult(probe.failure);
  }

  const pathspec = pathspecFor(probe.root, dir);
  const log = await runner(dir, logArgs({ limit, skip, pathspec }));
  if (!log.ok) {
    if (log.error.kind === "not-a-repository") {
      return { status: 200, json: { repo: false, reason: log.error.detail } };
    }
    return failureResult(log.error);
  }

  const commits = parseLog(log.stdout);
  return {
    status: 200,
    json: {
      repo: true,
      root: probe.root,
      branch: probe.branch,
      // The extra commit logArgs requested is the hasMore signal, not content.
      commits: commits.slice(0, limit),
      hasMore: commits.length > limit,
      skip,
      limit,
    },
  };
}

/** `GET /api/git/commit?path=&sha=` — one commit: message + changed-file stats. */
export async function gitCommitResponse(
  deps: GitRouteDeps,
  query: GitCommitQuery,
): Promise<GitRouteResult> {
  if (!deps.hasSession) return { status: 401, text: "Unauthorized" };

  const sha = query.sha ?? "";
  if (!validSha(sha)) return { status: 400, text: "Not a commit id" };

  const guard = guardDirectory(deps, query.path);
  if (!guard.ok) return guard.result;
  const dir = guard.real;

  const runner = deps.runner ?? runGit;
  // One probe decides both "is this a repository" (for the friendly state)
  // and the root the response names.
  const toplevel = await probeRoot(runner, dir);
  if (!toplevel.ok) {
    if (toplevel.error.kind === "not-a-repository") {
      return { status: 200, json: { repo: false, reason: toplevel.error.detail } };
    }
    return failureResult(toplevel.error);
  }
  const root = toplevel.stdout.trim();

  const show = await runner(dir, showArgs(sha));
  if (!show.ok) {
    if (show.error.kind === "bad-object") {
      return { status: 404, text: "No such commit" };
    }
    return failureResult(show.error);
  }

  return { status: 200, json: { repo: true, root, commit: parseShow(show.stdout) } };
}

/**
 * Everything that must be true before git is asked anything about `rawPath`.
 *
 * Order matters: the lexical clamp runs before any filesystem call, the
 * component-wise symlink guard before `realpath` (so nothing follows a link
 * on the way to deciding), and the realpath re-check before `git` — a link
 * that resolves out of the workspace is refused, not logged.
 */
function guardDirectory(
  deps: GitRouteDeps,
  rawPath: string | undefined,
): { ok: true; real: string } | { ok: false; result: GitRouteResult } {
  const root = deps.root ?? WORKSPACE_ROOT;
  const realpath = deps.realpath ?? realpathSync;
  const lstat = deps.lstat ?? lstatSync;

  const fail = (result: GitRouteResult): { ok: false; result: GitRouteResult } => ({
    ok: false,
    result,
  });

  if (!rawPath) return fail({ status: 400, text: "Missing path" });
  if (!rawPath.startsWith("/")) {
    return fail({ status: 400, text: `path must be an absolute path inside ${root}` });
  }
  const resolved = normalizePosixPath(rawPath);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    return fail({
      status: 400,
      text: `Path is outside the workspace: ${resolved} is not under ${root}`,
    });
  }

  const symlink = symlinkViolation(resolved, root, lstat);
  if (symlink) return fail({ status: 400, text: symlink });

  let real: string;
  try {
    real = realpath(resolved);
  } catch {
    return fail({ status: 404, text: "No such directory" });
  }
  const realNormalized = normalizePosixPath(real);
  if (realNormalized !== root && !realNormalized.startsWith(`${root}/`)) {
    return fail({
      status: 400,
      text: `Path is outside the workspace: ${real} is not under ${root}`,
    });
  }

  try {
    if (!lstat(real).isDirectory()) return fail({ status: 404, text: "Not a directory" });
  } catch {
    return fail({ status: 404, text: "No such directory" });
  }

  return { ok: true, real };
}

/** Map a git failure that is not the friendly `not-a-repository` case. */
function failureResult(failure: GitFailure): GitRouteResult {
  switch (failure.kind) {
    case "git-unavailable":
      return { status: 503, text: failure.detail };
    case "busy":
      return { status: 429, text: failure.detail };
    case "timed-out":
    case "output-too-large":
      return { status: 502, text: failure.detail };
    case "bad-object":
      return { status: 404, text: failure.detail };
    case "not-a-repository":
      return { status: 200, json: { repo: false, reason: failure.detail } };
    case "failed":
    default:
      return { status: 502, text: failure.detail };
  }
}
