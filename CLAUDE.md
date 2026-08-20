# letta-code-ui — Project Guide

Self-hosted personal assistant: a local Letta agent (memory, crons, skills) driven from a
mobile-first web UI we own end to end. No Letta Cloud, no cloud LLM providers.

## Workspace layout

```
/home/dima/work/letta/
  letta-code/      fork of letta-ai/letta-code — MUST stay byte-identical to upstream
  letta-code-ui/   this repo — everything we own
```

This file is the **only** CLAUDE.md. `letta-code/` keeps upstream's own `AGENTS.md`
(and its `CLAUDE.md -> AGENTS.md` symlink) untouched — that is upstream's file, not ours.

## The one hard rule: zero fork delta

`letta-code/` carries **no local changes**. Every capability we need already exists in its
app-server protocol. If something seems to require patching the fork, it is almost certainly
reachable through an existing protocol command — check `letta-code/src/types/protocol_v2.ts`
first. `scripts/sync-upstream.sh` asserts the delta is empty and will fail the sync if it is not.

Building the fork (`bun install && bun run build`) writes only to gitignored paths
(`node_modules/`, `dist/`), so it does not create a delta.

## Architecture

```
browser ──WSS+cookie──> bff (Bun/Hono) ──ws + Bearer──> letta app-server (docker)
                                                              ├── llama.cpp /v1
                                                              └── MCP servers
```

### The BFF is a session multiplexer, not a proxy

**This is the most important invariant in the codebase.** Exactly ONE upstream WebSocket
connection exists, owned by the BFF, opened at boot and never closed. Browser sessions
multiplex over it and are invisible to the app-server.

Why it must work this way — `letta-code/src/websocket/listener/connection-lifecycle.ts`
(`cleanupListenerConnection`): when a connection closes, if no other *subscribed* connection
remains for that `(agent_id, conversation_id)` scope, the app-server calls
`turnLifecycle.requestCancellation()` and **kills the in-flight turn**. It also drops that
connection's queued messages, rejects its pending approvals, and kills its terminals.

A phone browser backgrounding a tab drops its socket within seconds. If the browser owned the
upstream connection, every tab switch would abort the agent mid-turn. Because the BFF owns it,
none of that cleanup ever runs.

Corollaries — do not break these:
- Never open a second upstream connection, and never close the one that exists.
- Never forward a browser disconnect upstream in any form.
- The BFF allocates `request_id`s; browser ids are translated, never passed through.
- Missed frames are replayed from the BFF's per-conversation ring buffer, keyed by a monotonic
  sequence number. `conversation_messages_list` (cursor `next_before` / `has_more`) is the
  cold-start fallback when a tab was away longer than the buffer.

The same permanent connection is also what boots the cron scheduler and Telegram adapters:
app-server process services start on *first client attach*
(`listener/lifecycle.ts` → `startConnectedListenerRuntime`), so with no client ever connected,
crons never fire.

### Other load-bearing facts about the app-server

- **Browsers cannot reach it directly.** Auth is `Authorization: Bearer` only, which browsers
  cannot set on a WebSocket; and unauthenticated upgrades carrying `Origin` are rejected
  outright. The BFF is mandatory, not a convenience.
- **No per-user isolation.** One process-wide runtime; every socket sees every event. v1 is
  single-user by decision. Keep agent-id filtering in the BFF frame router so multi-user stays
  a small change.
- **MCP is not in the protocol.** Servers live in `~/.letta/settings.json` as a per-agent
  `mcpServers[]`. We edit that file over `read_file`/`write_file` and then
  `execute_command {command_id:"reload"}`.
- **No built-in web search/fetch tool.** Web search is an MCP server (searxng), not a
  letta-code feature.
- **Conversations DO have a native `archived` field** (plus `archived_at`), settable via
  `conversation_update {body:{archived}}` — verified against the local backend. But
  `conversation_list` ignores an `archived` query filter, so the *list* is filtered
  client-side. (An earlier note here claimed the field did not exist and prescribed a tag
  workaround; that was wrong.)
- **Rename** = `conversation_update {body:{summary}}`. A fresh conversation has
  `summary: null`, so the UI supplies its own placeholder.
- **`create_agent` presets** are exactly `memo | tutorial | blank | linus | kawaii`. There is
  no `default`.

## Upstream sync

`bun run sync-upstream` — fetches upstream, reports protocol drift, asserts zero fork delta,
rebuilds, and typechecks.

Protocol drift shows up two ways:
1. **Typed** — `web/` and `bff/` import from `@letta-ai/letta-code` (a `file:../letta-code`
   dependency), so `bun run typecheck` fails on any breaking protocol change.
2. **Behavioral** — types will NOT catch these; the sync script flags changes to:
   - `src/websocket/listener/connection-lifecycle.ts` — the turn-cancellation semantics above.
   - `src/channels/gateway-supervisor.ts` — `letta channel-gateway` has no `--ws-auth` support.
     Channels run in-process today, but if upstream moves them to the spawned gateway, our
     `--ws-auth capability-token` will break Telegram.

## Git workflow

Worktrees per feature, feature branches, direct merge to `main`, no PRs.

## Commands

| Command | What it does |
|---|---|
| `bun run typecheck` | Typecheck both packages — the protocol-drift detector |
| `bun run dev` | BFF + Vite dev server |
| `bun run sync-upstream` | Sync fork from upstream and report drift |
| `docker compose -f docker/compose.yml up` | App-server + BFF |
