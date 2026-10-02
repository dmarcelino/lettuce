---
description: Implement through the local run and the user's test, merge to main, stop before the push
---
Take the current change through `AGENTS.md`'s workflow and definition of done, stopping before
anything reaches `origin`. In order:

1. `bun run verify` green, in the worktree you are in. Fix and re-run until it is.
2. The changelog and docs duty: a user-visible change needs a `CHANGELOG.md` `[Unreleased]`
   entry in the same commit, plus `README.md` / `docs/CONFIGURATION.md` updates if it touched
   the configuration surface or a user-facing workflow. Read the `lettuce-releasing` skill for
   the voice and rules.
3. Commit on the feature branch (never on `main`).
4. Build and run it locally from this worktree. A worktree has no `docker/.env` (gitignored), so
   copy it in first (`cp ../../docker/.env docker/.env`) — without it the state-dir default lands
   inside `.worktrees/`:
   `docker compose -f docker/compose.yml build bff && docker compose -f docker/compose.yml up -d`
   — unscoped, never scoped to `app-server`, and never `up -d` without `build` for a UI change.
   Say plainly that the local stack is shared, so anything else being tested on this machine just
   got replaced by this branch.
5. **Stop and hand over for the user to test.** Name what to click and what should happen, then
   wait — this is the pause, not a formality. Nothing merges until they say it works; if it does
   not, go back to step 1 with their feedback.
6. Merge from the main checkout (`git merge --ff-only`), then prove it from `main`: rebuild `bff`,
   `bun run deploy-check` green, `bun run ui-check` green for any `web/` change, and
   `bun run smoke` if BFF session, protocol or settings paths changed.
7. Stop and report. Say the worktree path is merged and safe to remove — do not remove it or the
   branch yourself. **Do not `git push`, do not tag, do not touch prod**: the release is a
   separate, explicitly confirmed step (`/release`).
