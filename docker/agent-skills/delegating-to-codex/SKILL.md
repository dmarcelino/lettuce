---
name: delegating-to-codex
description: Load this before handing a self-contained coding job (write or fix code, run tests, refactor, investigate a repo) to a Codex worker with the Agent/Task tool and subagent_type "codex" — it says how to launch one, how to follow up or steer it, and what to do when Codex workers are disabled.
---

# Delegating coding work to a Codex worker

A **Codex worker** is the Codex CLI running as one of your background subagents. It works in
your current working directory with a shell and file editing, on the same local model setup the
user configured, and reports back to this conversation when it finishes.

## When to use one

- A well-scoped coding job that takes many shell steps: implement a function and its tests,
  fix a failing build, refactor a module, dig through a repository to answer a question.
- You want to keep working (or talking to the user) while it runs.

Do the work yourself instead when it is a one- or two-command job, or when it needs your
memory, your skills or a conversation with the user — the worker has none of those.

## Launching

Use your Agent/Task tool with `subagent_type: "codex"`, a short `description`, and a `prompt`
that stands alone: the worker sees nothing of this conversation. Say which directory and files,
what "done" means (e.g. "tests pass"), and what to report back.

- It always runs in the background; its result arrives later as a task notification.
- Add `mcp: { inherit: true }` if it needs your MCP servers (web search, etc.), or
  `mcp: { inherit: true, servers: ["name"] }` for just some. It reaches them through the
  `letta mcp` CLI under your identity.
- Do not pass `agent_id` or `conversation_id` — Codex workers cannot take them.

## Following up

The launch receipt contains an agent id like `codex_<uuid>`. Send it a message with
`SendAgentMessage` to steer a run that is still going, or to give a finished worker a follow-up
job — it resumes the same Codex session and still remembers the earlier work.

## If it fails at once

`Codex workers are disabled. Enable them in the web UI under Settings → Codex.` means exactly
that: tell the user, and do the work yourself meanwhile. Do not try to install, configure or
log in to Codex yourself — the web UI owns its configuration and rewrites it.

The user can watch every command a worker runs in the web UI (Tasks → Codex runs), so there is
no need to paste its whole log back; summarise what it did and what it found.
