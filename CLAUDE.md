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

### Channels (Telegram) — why the topology looks like this

Two facts in letta-code combine into one hard constraint:

1. The app-server **refuses to listen on a non-loopback address without `--ws-auth`**
   (`app-server.ts` → `isUnauthenticatedNonLoopbackListener`).
2. `letta channel-gateway` **sends no bearer token** (`gateway-local.ts` calls
   `createAppServerClient` with no `authToken`), so it cannot attach to an authenticated
   app-server.

Together: channels only work when the app-server listens on loopback with auth off. So the
app-server, the BFF, and the gateway all share one network namespace
(`network_mode: "service:app-server"`) and talk over `127.0.0.1:4500`. Nothing outside that
namespace can reach the app-server at all — stronger isolation than a shared token on a
bridge network, and it removes the capability token entirely.

**Channel configuration is not reachable from the web UI, by design of letta-code.** The
app-server only dispatches `channel_*` commands when `runtime.serviceCommandHandler` is set
(`message-router.ts`), and that is installed by `startChannelGatewaySupervisor` — which has
no production caller and communicates with its child gateway over **stdio**, not the
WebSocket. A `channel_*` command sent over the app-server socket is parsed, matched by
nothing, and silently dropped. They are therefore excluded from the BFF's browser allowlist:
a hang is worse than a refusal.

Telegram is set up once with the CLI inside the gateway container (see `docker/README.md`),
the same way llama.cpp is set up with `letta connect`. The gateway then runs it, and the
agent reaches it through the `MessageChannel` tool the gateway registers as an external tool.

### Other load-bearing facts about the app-server

- **Browsers cannot reach it directly.** Auth is `Authorization: Bearer` only, which browsers
  cannot set on a WebSocket; and unauthenticated upgrades carrying `Origin` are rejected
  outright. The BFF is mandatory, not a convenience.
- **No per-user isolation.** One process-wide runtime; every socket sees every event. v1 is
  single-user by decision. Keep agent-id filtering in the BFF frame router so multi-user stays
  a small change.
- **MCP is not in the protocol.** Servers live in `/root/.letta/settings.json` under
  `agents[<n>].mcpServers[]` (keyed by `agentId`). We read the file, merge into that one
  agent entry, write it back, and then `execute_command {command_id:"reload"}` — which
  replies "Reloaded settings, local mods, and agent secrets". Merge rather than replace:
  the file holds ~18 unrelated top-level settings including `deviceId`.
- **Provider connection state is `connected.is_connected`**, not `connected.connected`.
- **No built-in web search/fetch tool.** Web search is an MCP server (searxng), not a
  letta-code feature.
- **File protocol gotchas** (all verified against a running app-server):
  - `get_tree` returns paths **relative** to the root it was given; every other file command
    wants an absolute path, so the client must join them.
  - `grep_in_files` takes `query`, not `pattern`. Sending the wrong key produces **no response
    at all** rather than an error — a silent hang.
  - `grep_in_files` follows ripgrep defaults, so hidden and ignored files are skipped.
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
   - `src/channels/gateway-supervisor.ts` and `src/channels/gateway-local.ts` — if the gateway
     ever gains `--ws-auth`, the shared-network-namespace workaround below can be dropped.

## Git workflow

Worktrees per feature, feature branches, direct merge to `main`, no PRs.

## Commands

| Command | What it does |
|---|---|
| `bun run typecheck` | Typecheck both packages — the protocol-drift detector |
| `bun run dev` | BFF + Vite dev server |
| `bun run sync-upstream` | Sync fork from upstream and report drift |
| `docker compose -f docker/compose.yml up` | App-server + BFF |
