# lettuce — dev-flow playbook

<!-- Operator-owned and tracked: a change rides a flow and a PR like any other file. `flow init --write`
     writes the live copy on the operator's word; `flow init` alone runs the doctor. -->

## global

```flow
defaultBranch = main
branchPattern = feat/{slug}
worktreeDir = .dev-flow/{slug}/worktree
release.changelog = CHANGELOG.md
release.releases = true
```

```flow-guard
deny    \bgit\b[^\n]*--force(?!\w)                        :: a pushed branch is shared with CI and other sessions — update it by merging main into it
deny    \bgit\b[^\n]*\bpush\b(?!\w)[^\n]*\s-f(?!\w)       :: the short spelling of the force push above
confirm \bdocker\b[^\n]*\bcompose\b[^\n]*\b(?:rm|down|stop|kill)\b :: stops running containers
confirm \bdocker\b[^\n]*\bcompose\b[^\n]*\brestart\b      :: drops the permanent upstream connection and any turn in flight
confirm \bdocker\b[^\n]*\bcompose\b[^\n]*\bup\b[^\n]*(?:^|\s)app-server(?=\s|$) :: that service shares a network namespace with two others
protect docker/.env                                       :: gitignored live secrets — never echo the values
forbid  docker/secrets                                    :: gitignored secret storage
```

Feature work lives in the worktree dev-flow creates at `.dev-flow/<slug>/worktree`; the main checkout
stays on `main` with a clean tree and only takes merged PRs. Area mechanics live in `.agents/skills/lettuce-*/SKILL.md` —
read the one AGENTS.md's table names before planning. Upstream `letta-code/` is read-only and is never
patched. A plan document rides its own feature's branch and PR, never a PR of its own.

**Production deploy is the operator's alone:** the agent publishes — branch, PR, merge on the operator's
word for that PR, annotated tag — and stops there. It never deploys prod and never asks whether a deploy
happened.

A `flow-guard` rule matches shell text, not intent: a `gh pr create --body "…git branch -D…"` trips the
branch rule, so a body that quotes a command goes in a file and comes in with `--body-file`.

`protect` and `forbid` name a **path and its subtree**, never a glob: `protect docker/.env` covers that
file and anything under it, so a `docker/.env.bak-20261021` left beside it by a variable flip is outside
the rule and writes to it ask nothing — and writing `docker/.env*` is worse than nothing, since it names
one file literally called `.env*`. The tool-level defense for those backups is `.gitignore`'s `.env.*`,
so flip a variable **in place** instead of copying `.env` aside, and never `-f` add an ignored dotfile —
`git add -f docker/.env.bak` is a public secret, not a shortcut.

## plan

- [ ] (ui) mockups of every changed surface, rendered at 390 and 1280 and embedded in plan.md

Write the plan to `plan/` **as the discussion goes**, not when it ends: pi has auto-compacted at the
`release` stage twice now, and a plan that lived only in the transcript was gone with it — the gates read
the file, so the file is the work's memory. Pace the gates the same way: land each one's output on disk
before moving on.

Anything user-visible starts with `flow start <slug> --ui`. A docs-only change (nothing under `bff/`,
`web/` or `docker/`) still needs a flow: `flow start <slug> --patch` — and `--patch` / `--docs` are the
operator's grant in chat, never self-selected. Before asking for approval check
`git log origin/main..main --oneline` — local-only commits on `main` fall out of the worktree's base.
Check the other direction too: `flow approve` cuts the branch from **local** `main`'s tip, so a local
`main` behind `origin/main` puts the whole feature — its diff and every `flow check` it runs — on a
stale base, and nothing notices until pre-release pays for it in a merge plus a full CI re-run. So
`git fetch` and make the two agree (`git rev-parse main origin/main`) before `flow approve`, and merge
`main` into the branch when a parallel flow lands while you work — strict branch protection will demand
that merge before the PR can merge anyway, so doing it early only moves the cost earlier where it is cheap.

## implement

```flow
setup = cp -n "$(git rev-parse --git-common-dir)/../docker/.env" docker/.env && bun install
test = bun run verify
run = docker compose -f docker/compose.yml up -d
dev = bun run build:bff && docker compose -f docker/compose.yml up -d
health = for i in $(seq 1 30); do curl -fsS http://127.0.0.1:${BFF_PORT:-8090}/readyz && exit 0; sleep 2; done; exit 1
```

`bun run verify` is the whole offline half (worktree, version pins, prod-info, release hygiene, docs,
lint, typecheck, tests, build), so no separate `build` key. The commands assume `bun` on PATH, which the
harness env does not guarantee: `bun: command not found` means pi was started without `~/.bun/bin`, and
the fix is a symlink into a directory already on PATH (`ln -s ~/.bun/bin/bun ~/.local/bin/bun`) — a
machine fix, not a playbook edit. `bun run ui-check` can fail the same way from a fresh worktree: its
`bun install` resolves a Playwright whose pinned Chromium build is not the one this machine caches, so
either `npx playwright install chromium` once, or set `PLAYWRIGHT_CHROMIUM` to the cached
`~/.cache/ms-playwright/chromium_headless_shell-<build>/chrome-headless-shell-linux64/chrome-headless-shell`.
A fresh worktree has no `docker/.env` (gitignored) — `setup` copies it in when `flow approve` creates
the worktree, or the state-dir default lands inside `.dev-flow/<slug>/`. It reads the file from the
**main** checkout through `git rev-parse --git-common-dir`, because a linked worktree has no
`docker/.env` of its own and a
relative `../../` breaks the moment `worktreeDir` changes depth. **A failed `setup` does not re-run on the
next `approve`** — dev-flow reuses the worktree and prints `plan approved` with no `docker/.env` and no
`node_modules` (upstream dev-flow#49; it also runs `setup` for a `--docs` feature, which docs mode should
skip), so after a setup failure check both exist before trusting `flow check`. The local stack is one per machine and shared, so an
`up -d` replaced whatever another session was testing — say so out loud. A web/ change needs `build:bff`
first or the container serves the old bundle.

A look at the running stack never mutates operator state on its own. Move nothing under
`$LETTA_STATE_DIR` or `/app/auth`, never claim an instance you were not handed, and keep nothing durable in
a container path — the next recreate deletes it. A session that moved the sign-in hash aside to photograph a
locked screen, keeping its only backup inside `bff`, cost the operator their password when the container was
rebuilt. Copy state **out** to the host to photograph it, or add data instead of moving it.

`smoke` and `ui-check` both stop at `LETTUCE_TEST_PASSWORD` when the stack signs in with a password
(`scripts/harness.ts`), and an agent never stores that password: it is not a repo file, and exporting it
into a shell is the operator's per-machine choice. So an agent that cannot run them records **what it
probed in the container** instead — in the PR's *What was clicked* — and says plainly that a human pass on
the sign-in path is still owed. `flow verify` deploying and probing `/readyz` is not that pass and never
counts as one.

- [ ] built and running in the local container stack (unscoped `up -d`, `build:bff` first for any web/
      change) and the operator clicked through the change and said it works
- [ ] (ui) `bun run ui-check` screenshots plus a live look at 390 and 1280, reviewed as a whole screen
      — or `LETTUCE_TEST_PASSWORD` is not held: record the container probes and the owed human pass above

## pre-release

```flow
versionFile = VERSION
versionTag = {version}
changelog = CHANGELOG.md
releases = true
artifact = docker buildx imagetools inspect ghcr.io/dmarchevsky/lettuce-bff:{tag}
```

VERSION holds the whole release tag (`v<MAJOR>.<MINOR>.<PATCH>-letta_<LETTA_CODE_VERSION>`), which is
why `versionTag` is a bare `{version}` — do not let the doctor re-add the `v`. MINOR for new or changed
user-facing functionality, PATCH for everything else that ships. The version is cut here, per feature:
**one commit** bumps VERSION and renames `## [Unreleased]` to `## [v…] - <date>`, leaving an empty
`## [Unreleased]` above it — `check-release-hygiene` fails the branch when the two disagree, so a rename
without a bump is red. The heading an entry lands under is what CI derives the bump from: `### Added` and
`### Changed` are proof of a MINOR, so a PATCH flow files its entry under `### Fixed` or `### Removed`
— otherwise the derivation answers `unknown` against a `bump:patch` label. A flow that ships no version runs `flow release --no-version` on the operator's
word instead. Parallel branches collide on `VERSION` and `CHANGELOG.md`: merge `main` in and re-derive
the version before asking Release?, because the gate refuses a tag that already exists.

`VERSION` is not the only release literal: the compose image-tag default (`${LETTA_IMAGE_TAG:-v…}`) is a
release-literal site too and moves in the same commit — it is the tag a host without `LETTA_IMAGE_NS`
builds, and what CI compares against `VERSION` after the merge. `sync-upstream` leaves it alone on purpose.

- [ ] `ponytail-review` run on the change and every must-have and should-have finding fixed
- [ ] the CHANGELOG entry, the VERSION bump and any README / docs/CONFIGURATION.md sync in that one
      release-prep commit, and the `bump:minor` / `bump:patch` / `bump:none` label agrees with it
- [ ] the compose image-tag default moved with VERSION in that same commit
- [ ] the operator confirmed this exact tag, after being told the commit range and whether `app-server`
      gets recreated (an `app-server` recreate kills every in-flight turn; the BFF drain covers only bff)

## release

```flow
merge = merge
```

Publish only — the preparation happened above. Push the branch, open the PR from
`.github/pull_request_template.md`, wait for `ci` green, **merge it yourself**
(`gh pr merge <n> --merge`), `git fetch`, create the annotated tag at `main`'s tip and push it
**by name** (`git push origin v<x>`, never `--follow-tags`), then `flow release-done`, which creates
the GitHub Release for that tag (`release.releases = true`) with the changelog section as its notes. Nothing here deploys prod, and nothing is pushed, merged or
tagged without the operator's **Release?** for that specific change — a standing yes from an earlier
change is not one. The guard no longer intercepts `gh pr merge`: Release? is the authorization.

The tag *is* the publish trigger — pushing it runs `.github/workflows/publish.yml`, which pushes all five
images to GHCR and retags `latest` — so **`release.artifact` is what proves a release shipped**:
`flow release-done` fails if the registry does not hold the tag. It exists because two publishes came back
green and pushed nothing — `lettuce-pr-and-ci` says why a green Compose build is not proof of a push. A
green pipeline is not the artifact; the registry is. (An unversioned flow tags nothing, so this gate and
the artifact check both stand down.)

- [ ] after the merge and from `main`: `bun run build` **first** — `deploy-check` compares the served bundle
      against this host's `web/dist`, and after a release built in a worktree that copy is stale
      (`build:bff` refreshes the image, never the host's copy) — then `bun run deploy-check` green, plus
      `bun run ui-check` and `bun run smoke` where they apply. A merge that ships nothing an image carries
      (playbook, docs, CI) still leaves build identity naming an older sha: rebuild `bff`, or record that
      there was nothing to rebuild.
- [ ] a versioned release's **image tag lags the checkout** on a build-locally host: the compose tag default
      moved with `VERSION`, so nothing built before the merge carries the new name and build identity fails
      with no flag to forgive it. Fix from `main` with a clean tree — `bun run build:bff` then
      `docker compose -f docker/compose.yml up -d --no-deps bff` (`--no-deps` is what keeps `app-server`
      from coming along; see the recreation warning above) — and then `deploy-check` is green because
      `VERSION` at `main` now equals the tag the image gets. The published GHCR images are the shipped
      artifact either way; this only proves the local stack matches the release. A host that pulls images
      instead of building them sets `LETTA_IMAGE_NS` (and `LETTA_IMAGE_TAG`) in its own gitignored
      `docker/.env`, and that is the operator's choice, never an agent's edit.

**A release-tag bump guarantees an `app-server` recreation**, and an `app-server` recreation kills every
in-flight turn with no drain — the BFF's drain covers `bff` alone. So after a versioned release, even a
scoped `docker compose up -d bff` on a build-locally host recreates `app-server`, because its image tag
default moved with `VERSION`. Name it in the handoff, and use `--no-deps` when the turn in flight matters.
Earlier versions of this playbook asked only "does app-server get recreated?", which made it sound
optional; for a versioned release it is not.
