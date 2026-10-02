---
description: Run the offline gate (worktree, version-pin, docs, lint, typecheck, tests, build) and report
---
Run `bun run verify` in this checkout. If it fails, fix the failures and run it again until it
is green, then report the stage list and the outcome. Do not report the change as done from
this alone — the gate is the offline half (see "Definition of done" in `AGENTS.md`).
