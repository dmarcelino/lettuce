/**
 * The lettuce guard rules, as pure functions.
 *
 * Split out of `guard.ts` (the pi glue) so the matching logic is unit-testable
 * without a harness: `guard-core.test.ts` runs under `bun test`.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface Rule {
  /** Matched against one command segment (split on `&&`, `||`, `;`, `|`, newline). */
  pattern: RegExp;
  title: string;
  message: string;
  /** True = never allowed; no confirmation is offered. */
  hard?: boolean;
}

export interface ProtectedFile {
  /** Repo-root-relative path; a directory protects its subtree. */
  path: string;
  title: string;
  message: string;
  hard?: boolean;
}

/** Every entry is a rule `AGENTS.md` already states in prose. */
export const RULES: Rule[] = [
  {
    pattern: /\bgit\b[^\n]*\bpush\b(?!\w)/,
    title: "git push",
    message:
      "AGENTS.md: never push without the operator's explicit confirmation for THIS change. " +
      "Approving here is that confirmation — show them the commits first.",
  },
  {
    pattern: /\bgit\b[^\n]*--force(?!\w)/,
    title: "git --force",
    message: "Force operations are not part of this repo's workflow (fast-forward merges only).",
    hard: true,
  },
  {
    pattern: /\bgit\b[^\n]*\btag\b[^\n]*-a(?!\w)/,
    title: "git tag -a",
    message:
      "AGENTS.md: a tag is created only after the prod deploy is verified (definition of done 7b).",
  },
  {
    pattern: /\bgit\b[^\n]*\bworktree\s+(?:remove|prune)\b/,
    title: "git worktree",
    message:
      "AGENTS.md: the orchestrator owns worktree lifecycle. Another session may be sitting in " +
      "that worktree with uncommitted work.",
    hard: true,
  },
  {
    pattern: /\bgit\b[^\n]*\bbranch\s+(?:-[dD]|--delete)\b/,
    title: "git branch -d",
    message: "AGENTS.md: never delete a branch you did not create in this session.",
    hard: true,
  },
  {
    pattern: /\bdocker\b[^\n]*\bcompose\b[^\n]*\b(?:rm|down|stop|kill)\b/,
    title: "docker compose (destructive)",
    message:
      "This stops or removes running containers. AGENTS.md: prod containers are Dockhand's " +
      "business, and the app-server namespace also holds bff and channel-gateway.",
  },
  {
    pattern: /\bdocker\b[^\n]*\bcompose\b[^\n]*\brestart\b/,
    title: "docker compose restart",
    message:
      "Restarting a service drops the BFF's permanent upstream connection and any turn in flight.",
  },
  {
    pattern: /\bdocker\b[^\n]*\bcompose\b[^\n]*\bup\b[^\n]*(?:^|\s)app-server(?=\s|$)/,
    title: "recreate app-server",
    message:
      "AGENTS.md: never recreate `app-server` on its own — bff and channel-gateway share its " +
      "network namespace and will be left exited. Prefer the unscoped `up -d`.",
  },
];

/** Files an agent must never touch silently. */
export const PROTECTED_FILES: ProtectedFile[] = [
  {
    path: "docker/.env",
    title: "docker/.env",
    message:
      "docker/.env is gitignored and holds live secrets (SESSION_SECRET, tokens). Confirm only " +
      "if you are intentionally configuring this host, and never echo its values.",
  },
  {
    path: "docker/secrets",
    title: "docker/secrets/",
    message: "docker/secrets/ is gitignored secret storage.",
    hard: true,
  },
  {
    path: "VERSION",
    title: "VERSION",
    message:
      "AGENTS.md: VERSION is bumped by the release commit on main (`bun run release`), never by " +
      "an edit on a feature branch.",
  },
];

/**
 * Commands that only read. Quoting a forbidden command inside a grep or a doc
 * must not trip a gate, so only the "doing" segments of a command line are
 * inspected.
 */
const READ_ONLY =
  /^(?:grep|rg|egrep|fgrep|cat|bat|head|tail|less|more|sed|awk|jq|find|fd|ls|tree|wc|sort|uniq|column|cut|diff|cmp|stat|file|du|echo|printf|which|whereis|man|git\s+(?:log|show|diff|status|blame|cat-file|ls-files|rev-parse))\b/;

export function commandSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||[;\n|])/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !READ_ONLY.test(segment));
}

/** Every rule a single segment trips — a force-push trips two. */
export function rulesForSegment(segment: string): Rule[] {
  return RULES.filter((rule) => rule.pattern.test(segment));
}

/** Every (segment, rule) pair that a command line trips, in order. */
export function reviewCommand(command: string): Array<{ segment: string; rule: Rule }> {
  const hits: Array<{ segment: string; rule: Rule }> = [];
  for (const segment of commandSegments(command)) {
    for (const rule of rulesForSegment(segment)) hits.push({ segment, rule });
  }
  return hits;
}

/** Resolve a tool-supplied path to its real absolute location. */
export function normalizePath(path: string, cwd: string): string {
  const abs = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  // The file may not exist yet (a write); resolve the deepest existing ancestor.
  let probe = abs;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const base = probe.split(sep).pop();
    if (!base) break;
    tail.unshift(base);
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let real = probe;
  try {
    real = realpathSync(probe);
  } catch {
    /* keep the unresolved path */
  }
  return tail.length > 0 ? resolve(real, ...tail) : real;
}

export function relativeToRoot(absPath: string, root: string): string {
  return relative(root, absPath).split(sep).join("/");
}

export function protectedFileFor(repoRelative: string): ProtectedFile | null {
  return (
    PROTECTED_FILES.find(
      (file) => repoRelative === file.path || repoRelative.startsWith(`${file.path}/`),
    ) ?? null
  );
}

/** The protected file a tool path targets, if any. */
export function reviewPath(path: string, cwd: string, root: string): ProtectedFile | null {
  return protectedFileFor(relativeToRoot(normalizePath(path, cwd), root));
}
