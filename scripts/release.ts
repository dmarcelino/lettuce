/**
 * The release, as one gated command (see CLAUDE.md "Versioning and tags" and
 * "Stop before releasing to prod").
 *
 * It exists because the release is five manual steps with a human gate in the
 * middle, and two of them were easy to forget: the VERSION bump (it belongs on
 * `main` at release time, not on a feature branch — parallel worktrees cannot
 * know the next version, and two MINOR features merged together are one MINOR
 * release) and the tag after the verified deploy. The script computes the tag
 * mechanically from `VERSION` + the compose pin, makes the release commit on
 * `main`, and then runs the documented chain — deploy-check → plan → ONE
 * confirmation → push → deploy → verify → upstream-log check → tag → push tag —
 * stopping on the first failure without rolling anything back.
 *
 * Usage (from the main checkout, on `main`, clean tree):
 *   bun run release --minor | --patch [--message "..."] [--env letta] [--stack letta-code-ui-prod]
 *
 * The confirmation types the exact tag on a TTY; for a non-interactive caller
 * (an agent that has asked the human) set RELEASE_CONFIRM=<the exact tag>.
 */

import { homedir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname;
const DOCKHAND =
  process.env.DOCKHAND_SH ?? `${homedir()}/.claude/skills/dockhand-deploy/dockhand.sh`;

// ── Arguments ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name: string): string | null {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? "");
}
const bumpMinor = args.includes("--minor");
const bumpPatch = args.includes("--patch");
const message = flag("--message") || "";
const ENV = flag("--env") || "letta";
const STACK = flag("--stack") || "letta-code-ui-prod";

function die(step: string, why: string): never {
  console.log(`\n✗ STOPPED at ${step}: ${why}`);
  console.log("  Nothing was rolled back. Fix the cause and run again.");
  process.exit(1);
}

if (bumpMinor === bumpPatch) {
  die(
    "arguments",
    "exactly one of --minor or --patch is required (see CLAUDE.md versioning rules)",
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function git(...cmd: string[]): string {
  const result = Bun.spawnSync(["git", ...cmd], { cwd: ROOT });
  return new TextDecoder().decode(result.stdout).trim();
}

function gitOk(cmd: string[]): boolean {
  return Bun.spawnSync(cmd, { cwd: ROOT }).exitCode === 0;
}

async function run(cmd: string[]): Promise<number> {
  const child = Bun.spawn(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  return await child.exited;
}

async function capture(cmd: string[]): Promise<string> {
  const child = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(child.stdout).text();
  const code = await child.exited;
  process.stdout.write(out);
  if (code !== 0) throw new Error(`command failed (${code}): ${cmd.join(" ")}`);
  return out;
}

// ── 1. Preflight ─────────────────────────────────────────────────────────────
console.log("── preflight");
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") {
  die(
    "preflight",
    "not on main — the release commit is made on main, after every merge for this release",
  );
}
if (git("status", "--porcelain") !== "") die("preflight", "working tree is not clean");
if (git("tag", "--points-at", "HEAD") !== "") {
  die("preflight", "HEAD is already tagged — this release was cut");
}
git("fetch", "origin", "main");
if (!gitOk(["git", "merge-base", "--is-ancestor", "origin/main", "HEAD"])) {
  die("preflight", "local main has diverged from origin/main — rebase first");
}

const versionText = await Bun.file(`${ROOT}VERSION`)
  .text()
  .catch(() => "");
const current = versionText.trim();
const parsed = current.match(/^v(\d+)\.(\d+)\.(\d+)-letta_(\d+\.\d+\.\d+)$/);
if (!parsed) die("preflight", `VERSION is not a well-formed release tag: "${current}"`);

const changelog = await Bun.file(`${ROOT}CHANGELOG.md`)
  .text()
  .catch(() => "");
if (!changelog.includes("## [Unreleased]"))
  die("preflight", "CHANGELOG.md has no [Unreleased] section");
const newest = changelog.match(/^## \[(v[^\]]+)\]/m)?.[1];
if (newest !== current)
  die("preflight", `newest CHANGELOG section ${newest} != VERSION ${current}`);

// The suffix is read from the pin at tag time, never from memory (CLAUDE.md).
// The fenced pattern is check-version-pin's: it stays inside the app-server block.
const compose = await Bun.file(`${ROOT}docker/compose.yml`)
  .text()
  .catch(() => "");
const pin = compose.match(
  /^ {2}app-server:(?:(?!^ {2}\S)[\s\S])*?LETTA_CODE_VERSION:\s*\$\{LETTA_CODE_VERSION:-([0-9][^}]*)\}/m,
)?.[1];
if (!pin) die("preflight", "could not read LETTA_CODE_VERSION from docker/compose.yml");

const next = bumpMinor
  ? `v${parsed[1]}.${Number(parsed[2]) + 1}.0-letta_${pin}`
  : `v${parsed[1]}.${parsed[2]}.${Number(parsed[3]) + 1}-letta_${pin}`;
const ahead = git("rev-list", "--count", "origin/main..HEAD");
console.log(`  releasing ${ahead} commit(s): ${current} → ${next} (pin letta_${pin})`);

// ── 2. The release commit on main ────────────────────────────────────────────
console.log("\n── release commit");
const date = new Date().toISOString().slice(0, 10);
const renamed = changelog.replace("## [Unreleased]", `## [Unreleased]\n\n## [${next}] - ${date}`);
await Bun.write(`${ROOT}VERSION`, `${next}\n`);
await Bun.write(`${ROOT}CHANGELOG.md`, renamed);
await capture(["git", "add", "VERSION", "CHANGELOG.md"]);
await capture(["git", "commit", "-m", `chore(release): ${next}`]);
console.log(`  committed chore(release): ${next}`);

// ── 3. The local gate ────────────────────────────────────────────────────────
console.log("\n── deploy-check (the merged code must be what the local container runs)");
if ((await run(["bun", "run", "deploy-check"])) !== 0) {
  die(
    "deploy-check",
    "undo the release commit with: git reset --soft HEAD~1 && git restore VERSION CHANGELOG.md",
  );
}

// ── 4. Preflight, then the one confirmation ──────────────────────────────────
console.log("\n── dockhand plan");
await capture([DOCKHAND, "plan", ENV, STACK]);

console.log(`\nReleasing ${next}: push origin main → deploy ${ENV}/${STACK} → verify → tag.`);
let confirmed = false;
if (process.stdin.isTTY) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Type ${next} to release: `);
  rl.close();
  confirmed = answer.trim() === next;
} else {
  if (process.env.RELEASE_CONFIRM === undefined) {
    die(
      "confirmation",
      "not a TTY and RELEASE_CONFIRM is not set — a human must confirm this release",
    );
  }
  confirmed = process.env.RELEASE_CONFIRM === next;
}
if (!confirmed) die("confirmation", `the exact tag ${next} was not confirmed — nothing was pushed`);

// ── 5. Push, deploy, verify ──────────────────────────────────────────────────
console.log("\n── git push origin main");
await capture(["git", "push", "origin", "main"]);

console.log("\n── dockhand deploy");
const deployOut = await capture([DOCKHAND, "deploy", ENV, STACK, "--confirm"]);
if (!deployOut.includes("success exit=0")) die("deploy", "the deploy run did not report success");
const started = deployOut.match(/deploy started (\S+)/)?.[1];
if (!started) die("deploy", "could not parse the deploy start time for --since");

console.log("\n── dockhand verify");
const verifyOut = await capture([DOCKHAND, "verify", ENV, STACK, "--since", started]);
if (!verifyOut.includes("VERIFY: PASS"))
  die("verify", "verify did not PASS — review its output above");

console.log("\n── upstream connection");
const logs = await capture([DOCKHAND, "logs", ENV, `${STACK}-bff-1`, "200"]);
if (!logs.includes(`Upstream connected: letta-code ${pin}`)) {
  die("upstream", `the BFF log does not show "Upstream connected: letta-code ${pin}"`);
}

// ── 6. Tag ───────────────────────────────────────────────────────────────────
console.log("\n── tag");
await capture(["git", "tag", "-a", next, "-m", message || `release ${next}`]);
await capture(["git", "push", "origin", next]);

console.log(`\n✓ ${next} released: pushed, deployed, verified, tagged.`);
