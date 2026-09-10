/**
 * Asserts every copy of the letta-code version literal agrees.
 *
 * The app-server image, the channel-gateway image and the protocol types the UI
 * compiles against must all be the SAME release, or the UI is typechecked
 * against one protocol and talks to another. The literal is repeated in six
 * tracked files and nothing used to check them — CLAUDE.md said so outright
 * ("Nothing asserts they agree").
 *
 * `docker/.env` is reported but never fails the run: it is gitignored, so it
 * cannot be fixed by anyone reading this repo fresh, and a shell
 * LETTA_CODE_VERSION outranks it in Compose's precedence order anyway. A stale
 * value there is still worth saying out loud — that exact drift once sat
 * unnoticed through a whole release cycle.
 *
 * Usage: bun scripts/check-version-pin.ts
 */

const ROOT = new URL("..", import.meta.url).pathname;

interface Site {
  file: string;
  label: string;
  pattern: RegExp;
  /** Reported, never fatal. */
  advisory?: boolean;
}

const SITES: Site[] = [
  {
    file: "docker/compose.yml",
    label: "compose app-server build arg",
    pattern: /LETTA_CODE_VERSION:\s*"\$\{LETTA_CODE_VERSION:-([0-9][^}]*)\}"/,
  },
  {
    file: "docker/compose.yml",
    label: "compose channel-gateway image",
    pattern: /image:\s*letta\/letta:\$\{LETTA_CODE_VERSION:-([0-9][^}]*)\}/,
  },
  {
    file: "docker/app-server.Dockerfile",
    label: "app-server ARG default",
    pattern: /^ARG LETTA_CODE_VERSION=(.+)$/m,
  },
  {
    file: "package.json",
    label: "root devDependency",
    pattern: /"@letta-ai\/letta-code":\s*"([^"]+)"/,
  },
  {
    file: "bff/package.json",
    label: "bff dependency",
    pattern: /"@letta-ai\/letta-code":\s*"([^"]+)"/,
  },
  {
    file: "web/package.json",
    label: "web dependency",
    pattern: /"@letta-ai\/letta-code":\s*"([^"]+)"/,
  },
  {
    file: "docker/.env",
    label: "docker/.env (gitignored)",
    pattern: /^LETTA_CODE_VERSION=(.+)$/m,
    advisory: true,
  },
];

interface Found extends Site {
  version: string;
}

const found: Found[] = [];
const problems: string[] = [];

for (const site of SITES) {
  const text = await Bun.file(`${ROOT}${site.file}`)
    .text()
    .catch(() => null);

  if (text === null) {
    if (!site.advisory) problems.push(`${site.file}: not found`);
    continue;
  }

  const match = text.match(site.pattern);
  if (!match?.[1]) {
    if (!site.advisory) problems.push(`${site.file}: no ${site.label} found`);
    continue;
  }

  found.push({ ...site, version: match[1].trim() });
}

const authoritative = found.filter((site) => !site.advisory);
const versions = new Set(authoritative.map((site) => site.version));

for (const site of found) {
  const mark = site.advisory && versions.size === 1 && !versions.has(site.version) ? "!" : " ";
  console.log(`  ${mark} ${site.version.padEnd(12)} ${site.file}  (${site.label})`);
}

if (versions.size > 1) {
  problems.push(`pins disagree: ${[...versions].sort().join(" vs ")}`);
}

const drifted = found.filter(
  (site) => site.advisory && versions.size === 1 && !versions.has(site.version),
);
for (const site of drifted) {
  console.log(
    `\n  ! ${site.file} says ${site.version}, everything tracked says ${[...versions][0]}.` +
      `\n    Compose reads that file, so a build without an explicit LETTA_CODE_VERSION` +
      `\n    would use the stale value. Not fatal here because the file is gitignored.`,
  );
}

if (problems.length > 0) {
  console.log(`\n✗ version pin check FAILED`);
  for (const problem of problems) console.log(`    ${problem}`);
  process.exit(1);
}

console.log(`\n✓ letta-code pinned consistently at ${[...versions][0]}`);
