/**
 * The "is it actually live" half of the definition of done (see CLAUDE.md).
 *
 * `web/dist` is baked into the bff image at build time and is NOT mounted, so
 * `docker compose up -d` without a preceding `build bff` silently keeps serving
 * the previous SPA. That is exactly how a change was once reported as shipped
 * while the browser still had the old bundle. This asserts otherwise.
 *
 * Usage: bun run deploy-check [bffOrigin]
 */

const ORIGIN = process.argv[2] ?? "http://127.0.0.1:8090";
const ROOT = new URL("..", import.meta.url).pathname;

let failures = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log(`        ${detail}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  return new TextDecoder().decode(result.stdout).trim();
}

/** The hashed entry bundle, e.g. "assets/index-uBL3eADi.js". */
function bundleName(html: string): string | null {
  return html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null;
}

// ── 1. Release preconditions ───────────────────────────────────────────────
section("Release preconditions");

const dirty = git("status", "--porcelain");
check("working tree is clean", dirty === "", dirty.split("\n").slice(0, 5).join(" | "));

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
check("on main", branch === "main", `on "${branch}"`);

const worktrees = git("worktree", "list").split("\n").filter(Boolean);
check("no leftover feature worktrees", worktrees.length <= 1, worktrees.slice(1).join(" | "));

// ── 2. The running image matches the built bundle ──────────────────────────
section("Deployed bundle");

const localHtml = await Bun.file(`${ROOT}web/dist/index.html`)
  .text()
  .catch(() => "");
const localBundle = bundleName(localHtml);
check("web/dist exists and names a bundle", localBundle !== null, "run: bun run build");

let servedBundle: string | null = null;
try {
  const response = await fetch(`${ORIGIN}/`, { signal: AbortSignal.timeout(5000) });
  servedBundle = bundleName(await response.text());
} catch (cause) {
  check(`${ORIGIN} is reachable`, false, cause instanceof Error ? cause.message : cause);
}

if (localBundle && servedBundle) {
  check(
    "served bundle matches web/dist",
    servedBundle === localBundle,
    `serving ${servedBundle}, local web/dist is ${localBundle} — these must match. ` +
      "Either side can be the stale one: run `bun run build` if web/dist predates " +
      "your last source change, or `docker compose -f docker/compose.yml build bff " +
      "&& ... up -d bff` if the image does.",
  );
}

// ── 3. The stack is healthy ────────────────────────────────────────────────
section("Stack health");

try {
  const response = await fetch(`${ORIGIN}/readyz`, { signal: AbortSignal.timeout(5000) });
  const ready = (await response.text()).trim();
  // /readyz is the whole health signal: 200 "ok" when the BFF's permanent
  // upstream connection is live, 503 "app-server <state>" otherwise. It is
  // deliberately unauthenticated, unlike /api/status, which no longer reports
  // upstream state to an anonymous caller.
  check(
    "upstream app-server is connected",
    response.ok && ready === "ok",
    `${response.status} ${ready}`,
  );
} catch (cause) {
  check("stack responds", false, cause instanceof Error ? cause.message : cause);
}

console.log(
  failures === 0
    ? "\n✓ deploy-check passed — the merged code is what is running."
    : `\n✗ deploy-check FAILED (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
