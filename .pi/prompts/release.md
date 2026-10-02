---
description: The gated prod release — preflight, explicit confirmation, push, deploy, verify, tag
argument-hint: "--minor | --patch"
---
You are about to release to production. Read the "Stop before releasing to prod" section of
`AGENTS.md` and the `lettuce-releasing` skill first, then:

1. Preflight. `main` must be checked out, clean, and `bun run verify` green. If the
   `[Unreleased]` changelog range changed anything `README.md` or `docs/CONFIGURATION.md`
   describes, make that docs commit on `main` now (it must be its own commit —
   `release.ts` stages only `VERSION` and `CHANGELOG.md`).
2. `bun run release --minor` or `--patch` (whichever the changelog warrants) up to but not past
   its confirmation prompt. It computes the tag from `VERSION` plus the compose pin, makes the
   release commit on `main`, runs `deploy-check`, and prints the Dockhand plan.
3. Re-read the target from `dockhand.sh stacks letta` — never from memory — and compare it to the
   table in `AGENTS.md`. If it does not match, stop.
4. Show the human the preflight and ask for explicit confirmation: the commit range, whether
   `docker/compose.yml` changed, which containers get recreated (call out an `app-server`
   recreate: it kills every in-flight turn with no drain), and the previous deploy's duration.
   The harness will also block `git push` until the operator confirms it. Never type the
   confirmation yourself and never reuse an earlier yes.
5. If the `dockhand-deploy` skill is not installed on this machine, the release ends at
   `git push origin main`: report the pushed commit range and say the prod redeploy is theirs.
   Do not substitute ad-hoc Dockhand API calls.
6. After the deploy: `dockhand.sh verify letta letta-code-ui-prod --since <printed time>`, and the
   BFF log must show `Upstream connected: letta-code <pinned version>`. Only then tag
   `main`'s HEAD with `$(cat VERSION)` and push the tag. On any failure, stop and report — no
   retry, no rollback, no restart without the user choosing it.
