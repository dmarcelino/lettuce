import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyGitFailure, type GitResult, NOT_A_REPOSITORY_STDERR } from "./log.ts";
import { type GitRouteDeps, gitCommitResponse, gitLogResponse } from "./routes.ts";
import type { GitRunner } from "./service.ts";

// The routes clamp against /work in production; tests move the root to a real
// temporary directory so the filesystem half of the guard runs for real.
const root = realpathSync(mkdtempSync(join(tmpdir(), "git-routes-")));
mkdirSync(join(root, "repo", "src"), { recursive: true });
writeFileSync(join(root, "repo", "file.txt"), "x\n");
writeFileSync(join(root, "repo", "src", "a.txt"), "a\n");
mkdirSync(join(root, "plain"));
symlinkSync(join(root, "repo"), join(root, "link"));
const repoDir = join(root, "repo");

const okRes = (stdout: string): GitResult => ({ ok: true, stdout });
const failKind = (kind: string): GitResult => ({
  ok: false,
  error: { kind: kind as never, detail: `${kind} detail` },
});
const notARepo: GitResult = {
  ok: false,
  error: classifyGitFailure(NOT_A_REPOSITORY_STDERR, 128),
};

const logRecord = (sha: string, subject: string): string =>
  `${sha}\x1f${sha.slice(0, 7)}\x1fTester\x1f2026-10-02T11:16:37-07:00\x1fHEAD -> main\x1f${subject}\x1e`;

const showOut = (sha: string): string =>
  `${sha}\x1fTester\x1f2026-10-02T11:16:37-07:00\x1fsome commit\n\x1e\n\n:100644 100644 aaaaaaa bbbbbbb M\tfile.txt\n1\t0\tfile.txt\n`;

/** Records every argv the handler asks for, answering from canned scripts. */
function scriptedRunner(answerFor: (args: string[]) => GitResult, calls: string[][]): GitRunner {
  return async (_dir, args) => {
    calls.push([...args]);
    return answerFor(args);
  };
}

function repoAnswers(calls: string[][]): GitRunner {
  return scriptedRunner((args) => {
    if (args[0] === "rev-parse" && args[1] === "--git-dir") return okRes(".git\n");
    if (args.join(" ") === "rev-parse --show-toplevel") return okRes(`${repoDir}\n`);
    if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return okRes("main\n");
    if (args[0] === "log")
      return okRes(`${logRecord("a".repeat(40), "first")}${logRecord("b".repeat(40), "second")}`);
    if (args[0] === "show") return okRes(showOut("a".repeat(40)));
    return failKind("failed");
  }, calls);
}

const session = { hasSession: true } satisfies Partial<GitRouteDeps>;

describe("GET /api/git/log handler", () => {
  test("no session means no git, at all", async () => {
    const calls: string[][] = [];
    const result = await gitLogResponse(
      { hasSession: false, runner: repoAnswers(calls), root },
      { path: repoDir },
    );
    expect(result.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("a path outside the workspace is refused before anything touches the disk", async () => {
    const calls: string[][] = [];
    const deps: GitRouteDeps = { ...session, runner: repoAnswers(calls), root };
    expect((await gitLogResponse(deps, { path: "/etc/passwd" })).status).toBe(400);
    expect((await gitLogResponse(deps, { path: `${root}/../escape` })).status).toBe(400);
    expect((await gitLogResponse(deps, { path: "relative/dir" })).status).toBe(400);
    expect((await gitLogResponse(deps, {})).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("a symlink out of the workspace is refused; git is never asked", async () => {
    const calls: string[][] = [];
    const result = await gitLogResponse(
      { ...session, runner: repoAnswers(calls), root },
      {
        path: join(root, "link"),
      },
    );
    expect(result.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("a realpath that lands outside the workspace is refused", async () => {
    const calls: string[][] = [];
    const result = await gitLogResponse(
      { ...session, runner: repoAnswers(calls), root, realpath: () => "/somewhere/else" },
      { path: repoDir },
    );
    expect(result.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("missing directory and plain file both answer 404", async () => {
    const calls: string[][] = [];
    const deps: GitRouteDeps = { ...session, runner: repoAnswers(calls), root };
    expect((await gitLogResponse(deps, { path: join(root, "nope") })).status).toBe(404);
    expect((await gitLogResponse(deps, { path: join(root, "plain") })).status).toBe(200); // a repo-less dir is not a 404
    expect((await gitLogResponse(deps, { path: join(root, "repo", "file.txt") })).status).toBe(404);
  });

  test("limit and skip are clamped or refused", async () => {
    const calls: string[][] = [];
    const deps: GitRouteDeps = { ...session, runner: repoAnswers(calls), root };
    expect((await gitLogResponse(deps, { path: repoDir, limit: "0" })).status).toBe(400);
    expect((await gitLogResponse(deps, { path: repoDir, limit: "abc" })).status).toBe(400);
    expect((await gitLogResponse(deps, { path: repoDir, skip: "-1" })).status).toBe(400);
    const clamped = await gitLogResponse(deps, { path: repoDir, limit: "500" });
    expect(clamped.status).toBe(200);
    expect((clamped.json as { limit: number }).limit).toBe(200);
  });

  test("not a repository is a 200 with the reason, not an error", async () => {
    const calls: string[][] = [];
    const runner = scriptedRunner((args) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return notARepo;
      return failKind("failed");
    }, calls);
    const result = await gitLogResponse(
      { ...session, runner, root },
      { path: join(root, "plain") },
    );
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      repo: false,
      reason: "fatal: not a git repository (or any of the parent directories): .git",
    });
    // Only the probe ran; no log call after a refusal.
    expect(calls.length).toBe(1);
  });

  test("a repository answers the page, with branch and root", async () => {
    const calls: string[][] = [];
    const result = await gitLogResponse(
      { ...session, runner: repoAnswers(calls), root },
      {
        path: repoDir,
      },
    );
    expect(result.status).toBe(200);
    const body = result.json as {
      repo: boolean;
      root: string;
      branch: string;
      commits: { subject: string }[];
      hasMore: boolean;
    };
    expect(body.repo).toBe(true);
    expect(body.root).toBe(repoDir);
    expect(body.branch).toBe("main");
    expect(body.commits.map((commit) => commit.subject)).toEqual(["first", "second"]);
    expect(body.hasMore).toBe(false);
  });

  test("limit + 1 is requested and the extra commit becomes hasMore", async () => {
    const calls: string[][] = [];
    const result = await gitLogResponse(
      { ...session, runner: repoAnswers(calls), root },
      {
        path: repoDir,
        limit: "1",
      },
    );
    const body = result.json as { commits: unknown[]; hasMore: boolean };
    expect(body.commits.length).toBe(1);
    expect(body.hasMore).toBe(true);
    const logCall = calls.find((args) => args[0] === "log");
    expect(logCall).toBeDefined();
    expect(logCall?.[logCall.indexOf("-n") + 1]).toBe("2");
  });

  test("the open subfolder becomes a repo-relative pathspec", async () => {
    const calls: string[][] = [];
    await gitLogResponse(
      { ...session, runner: repoAnswers(calls), root },
      {
        path: join(repoDir, "src"),
      },
    );
    const logCall = calls.find((args) => args[0] === "log");
    expect(logCall?.slice(logCall.indexOf("--end-of-options"))).toEqual([
      "--end-of-options",
      "--",
      "src",
    ]);
  });

  test("infrastructure failures map to 503, 429 and 502", async () => {
    const depsFor = (result: GitResult): GitRouteDeps => ({
      ...session,
      root,
      runner: scriptedRunner(() => result, []),
    });
    expect(
      (await gitLogResponse(depsFor(failKind("git-unavailable")), { path: repoDir })).status,
    ).toBe(503);
    expect((await gitLogResponse(depsFor(failKind("busy")), { path: repoDir })).status).toBe(429);
    expect((await gitLogResponse(depsFor(failKind("timed-out")), { path: repoDir })).status).toBe(
      502,
    );
  });
});

describe("GET /api/git/commit handler", () => {
  test("no session means no git", async () => {
    const calls: string[][] = [];
    const result = await gitCommitResponse(
      { hasSession: false, runner: repoAnswers(calls), root },
      { path: repoDir, sha: "889c5f8" },
    );
    expect(result.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("only a lowercase hex sha gets through", async () => {
    const calls: string[][] = [];
    const deps: GitRouteDeps = { ...session, runner: repoAnswers(calls), root };
    for (const sha of ["889C5F8", "xyz1234", "889", "a".repeat(41), "889c5f8; rm -rf /", ""]) {
      const result = await gitCommitResponse(deps, { path: repoDir, sha });
      expect(result.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test("a valid sha answers the parsed commit", async () => {
    const calls: string[][] = [];
    const result = await gitCommitResponse(
      { ...session, runner: repoAnswers(calls), root },
      {
        path: repoDir,
        sha: "889c5f8",
      },
    );
    expect(result.status).toBe(200);
    const body = result.json as { repo: boolean; root: string; commit: { files: unknown[] } };
    expect(body.repo).toBe(true);
    expect(body.root).toBe(repoDir);
    expect(body.commit.files.length).toBe(1);
  });

  test("an unknown object is a 404", async () => {
    const calls: string[][] = [];
    const runner = scriptedRunner((args) => {
      if (args[0] === "show") {
        return {
          ok: false,
          error: classifyGitFailure(
            "fatal: ambiguous argument 'deadbeef': unknown revision or path not in the working tree.",
            128,
          ),
        };
      }
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return okRes(".git\n");
      if (args.join(" ") === "rev-parse --show-toplevel") return okRes(`${repoDir}\n`);
      return failKind("failed");
    }, calls);
    const result = await gitCommitResponse(
      { ...session, runner, root },
      {
        path: repoDir,
        sha: "deadbeef",
      },
    );
    expect(result.status).toBe(404);
  });

  test("not a repository answers the friendly state here too", async () => {
    const calls: string[][] = [];
    const runner = scriptedRunner(() => notARepo, calls);
    const result = await gitCommitResponse(
      { ...session, runner, root },
      {
        path: join(root, "plain"),
        sha: "889c5f8",
      },
    );
    expect(result.status).toBe(200);
    expect((result.json as { repo: boolean }).repo).toBe(false);
  });
});
