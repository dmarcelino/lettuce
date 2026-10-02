/**
 * Git history of a workspace folder, as the browser sees it. Everything goes
 * through the BFF's /api/git routes — the log is read there, by read-only
 * `git` against the BFF's read-only /work mount, because upstream exposes
 * only branch commands. The types mirror `bff/src/git/`; the two packages
 * cannot import from each other (same split as `lib/codex.ts`).
 */

export const GIT_PAGE_SIZE = 50;

export interface GitCommitEntry {
  sha: string;
  shortSha: string;
  author: string;
  /** ISO 8601 with offset. */
  date: string;
  /** Branch/tag names pointing at this commit. */
  refs: string[];
  /** True on the checked-out tip. */
  isCurrent: boolean;
  subject: string;
}

/** A page of the log. `repo: false` is a friendly state, not an error. */
export type GitLogResponse =
  | {
      repo: true;
      /** The repository root, resolved by git. */
      root: string;
      /** Branch name, or `HEAD` when detached. */
      branch: string;
      commits: GitCommitEntry[];
      hasMore: boolean;
      skip: number;
      limit: number;
    }
  | { repo: false; reason: string };

export interface GitChangedFile {
  /** A/M/D/R/… from git, or null when unknown. */
  status: string | null;
  path: string;
  oldPath: string | null;
  /** null means binary. */
  additions: number | null;
  deletions: number | null;
}

export interface GitCommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  message: string;
  messageTruncated: boolean;
  files: GitChangedFile[];
  fileCount: number;
  filesTruncated: boolean;
}

export type GitCommitResponse =
  | { repo: true; root: string; commit: GitCommitInfo }
  | { repo: false; reason: string };

/**
 * "Is this folder at or inside a repository?" — the one answer the Files tab
 * uses to decide whether to offer Branch and History at all. Same two shapes
 * as the log: `repo: false` is a friendly state, not an error.
 */
export type GitRepoResponse =
  | { repo: true; root: string; branch: string }
  | { repo: false; reason: string };

async function ok(response: Response): Promise<Response> {
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response;
}

export async function fetchGitRepo(path: string): Promise<GitRepoResponse> {
  const response = await ok(await fetch(`/api/git/repo?${new URLSearchParams({ path })}`));
  return (await response.json()) as GitRepoResponse;
}

export async function fetchGitLog(
  path: string,
  options: { limit?: number; skip?: number } = {},
): Promise<GitLogResponse> {
  const params = new URLSearchParams({ path });
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.skip) params.set("skip", String(options.skip));
  const response = await ok(await fetch(`/api/git/log?${params}`));
  return (await response.json()) as GitLogResponse;
}

export async function fetchGitCommit(path: string, sha: string): Promise<GitCommitResponse> {
  const params = new URLSearchParams({ path, sha });
  const response = await ok(await fetch(`/api/git/commit?${params}`));
  return (await response.json()) as GitCommitResponse;
}
