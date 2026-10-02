---
description: Take the current change through the definition of done up to (never past) the push
---
Take the current change through the definition of done in `AGENTS.md`, stopping before anything
reaches `origin`. In order:

1. `bun run verify` green. Fix and re-run until it is.
2. The changelog and docs duty: a user-visible change needs a `CHANGELOG.md` `[Unreleased]`
   entry in the same commit, plus `README.md` / `docs/CONFIGURATION.md` updates if it touched
   the configuration surface or a user-facing workflow. Read the `lettuce-releasing` skill for
   the voice and rules.
3. Commit on the feature branch you are on (never on `main`), then fast-forward it into `main`
   from the main checkout (`git merge --ff-only`). Do not remove the worktree or the branch.
4. Rebuild and restart only what changed:
   `docker compose -f docker/compose.yml build bff && docker compose -f docker/compose.yml up -d bff`
   — never `up -d` scoped to `app-server`, and never `docker compose up -d` without `build` for a
   UI change.
5. `bun run deploy-check` green, and `bun run ui-check` green for any `web/` change. Run
   `bun run smoke` if BFF session, protocol or settings paths changed.
6. Stop and report. **Do not `git push`, do not tag, do not touch prod** — the release is a
   separate, explicitly confirmed step (`/release`).
