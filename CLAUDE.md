# letta-code-ui — Project Guide

Self-hosted personal assistant: a local Letta agent (memory, crons, skills) driven from a
mobile-first web UI we own end to end. No Letta Cloud, no cloud LLM providers.

## Workspace layout

```
/home/dima/work/letta/
  letta-code/      plain clone of letta-ai/letta-code at the pinned release tag — read-only
  letta-code-ui/   this repo — everything we own
```

**The upstream clone is dev tooling, not a build input.** Nothing in `letta-code/` is compiled into any
image and nothing outside `letta-code-ui/` is in any build context. The channel-gateway runs
upstream's published `letta/letta:<version>` as-is; the app-server runs a thin image built
`FROM` it that only adds the Codex CLI and our `codex` shim (`docker/codex/`, see "Codex
workers"); the UI consumes
`@letta-ai/letta-code` from npm. The checkout exists so `sync-upstream.sh` can diff it and so
you can read the source (the npm package ships only `dist/`). A prod host needs only `git` and
`docker` — no `bun`, no letta-code checkout.

There is no fork. There used to be one (`dmarchevsky/letta-code`), but the zero-delta rule
meant it could never hold anything upstream did not, and nobody pushed to it — it simply fell
behind. A missing `letta-code/` is recreated by `sync-upstream.sh` (`git clone` of upstream).

This file is the **only** CLAUDE.md. `letta-code/` keeps upstream's own `AGENTS.md`
(and its `CLAUDE.md -> AGENTS.md` symlink) untouched — that is upstream's file, not ours.

## The one hard rule: upstream is not ours to patch

We run upstream's published artifacts unmodified, and `letta-code/` carries **no local
changes**. Every capability we need already exists in its app-server protocol. If something
seems to require patching letta-code, it is almost certainly reachable through an existing
protocol command — check `letta-code/src/types/protocol_v2.ts` first. `scripts/sync-upstream.sh`
refuses to run against a dirty checkout.

Building the checkout (`bun install && bun run build`) writes only to gitignored paths
(`node_modules/`, `dist/`), so it does not dirty it — but nothing needs that build, so there is
rarely a reason to run it.

## Architecture

```
browser ──WSS+cookie──> bff (Bun/Hono) ──ws + Bearer──> letta app-server (docker)
                                                              ├── llama.cpp /v1
                                                              └── mods (native tools) ─> bff /internal/tools/<name>
                                                                    ├─ web_search / fetch_webpage ─> searxng, ddg-mcp
                                                                    ├─ gmail_* / calendar_* / tasks_* ─> google-mcp
                                                                    └─ mcp_search / mcp_call[_write] ─> shared MCP list
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
- The BFF's own syncs (reconnect `resubscribe()` and the scope sweep) carry
  `resume_interrupted_turn: true`: this connection is every conversation's execution owner, so
  after an app-server restart a turn left with only replay-unsafe tool calls pending resumes
  immediately (those calls are denied) instead of waiting for a user message. Browser syncs stay
  observer syncs and never get the flag.
- Missed frames are replayed from the BFF's per-conversation ring buffer, keyed by a monotonic
  sequence number. `conversation_messages_list` (cursor `next_before` / `has_more`) is the
  cold-start fallback when a tab was away longer than the buffer.

**A `bff` redeploy is the one time the connection does close — so shutdown drains first.**
Stopping the BFF closes that socket, which cancels every in-flight turn exactly as above. Worse,
the cancel cannot reach llama.cpp (see "Stop cannot actually cancel"), so the backend run keeps
going; the new BFF's owner sync then re-sends the interrupted tool calls into a conversation
that is still busy, `send.ts` `maybeWaitForBlockingRun` waits out `BUSY_RUN_WAIT_TIMEOUT_MS`
(5 min) and the turn ends with `Conversation is still busy because run … remained active after
300000ms`. **Signature: an error push exactly five minutes after a BFF restart, then a
"completed" push shortly after, and nothing in the transcript** (seen on prod 2026-09-25 with a
two-hour cron turn). `bff/src/shutdown.ts` therefore holds SIGTERM until `ActivityTracker`
reports no turn in progress, up to `SHUTDOWN_DRAIN_TIMEOUT_SECONDS` (default 15 min), while
still serving browsers; a second signal skips the wait. `stop_grace_period: 16m` in
`docker/compose.yml` is what lets it — Docker's default 10 s SIGKILLs the drain — and it must
stay above the drain timeout. So a `bff` deploy during a turn now takes until that turn ends
to stop the old container. A turn longer than the cap still dies.

**Turn errors are live-only upstream, so the BFF keeps them.** A failed turn reaches clients
as a `loop_error` delta and `turn_finished.error`; neither is written to the message store, so
`conversation_messages_list` cannot show it and a failure nobody watched vanished on reload.
`bff/src/session/turn-errors.ts` records the last few per scope (in memory), served at
`GET /api/turn-errors`, and `mergeTurnErrors` (`web/src/lib/messages.ts`) slots them back into
the rebuilt transcript by date. The failure push also carries the error's first line.

**A turn push waits for the agent to be done, not for `turn_finished`.** One request often spans
several turns — a queued message runs next, a background subagent reports back later as a task
notification with a turn of its own — and `turn_finished` fires for each, so pushing on it said
"finished" mid-work and then again. `bff/src/push/turn-watcher.ts` holds a finished turn until
the scope has had nothing processing (`update_device_status`), nothing queued that will run
(`update_queue`, paused items excluded) and no pending/running subagent (`update_subagent_state`)
for `SETTLE_MS` (5 s), then pushes the **last** turn's outcome, capped at `MAX_HOLD_MS` (30 min)
so a stuck subagent cannot swallow it. Whether a session is watching is decided when the push is
due. Titles name the agent (`agent_retrieve` via the permanent connection, cached 10 min in
`push/agent-names.ts`, "Letta" if the lookup fails).

**An expired login must not look like "offline".** A refused WebSocket upgrade reaches the
browser as close code 1006 with no HTTP status, identical to a dropped network, so the PWA used
to sit on "Reconnecting…" until a manual reload. Two rules follow:
- `/ws` resolves the session exactly like HTTP (`bff/src/auth/resolve-session.ts`: cookie, else
  the Access JWT, minting a cookie onto the 101). A signed-out upgrade is **accepted and closed
  with 4401** after a `__bff_auth_required` frame — never refused — because a close code is the
  one signal the browser can read.
- An expired **Cloudflare Access** login is blocked at the edge before the BFF sees it, so no
  close code can report it. After two consecutive failed opens `SessionClient` probes
  `/api/status` with `redirect: "manual"` (`web/src/lib/auth-probe.ts`): an `opaqueredirect`,
  401/403 or `authenticated: false` means signed out → link state `signed-out`, and
  `use-session.ts` reloads the page once (top-level navigation is the only way through Access's
  login), at most every 5 minutes; after that the pill is a "Sign in again" button. A network
  error keeps the ordinary backoff.

The same permanent connection is also what boots the cron scheduler and Telegram adapters:
app-server process services start on *first client attach*
(`listener/lifecycle.ts` → `startConnectedListenerRuntime`), so with no client ever connected,
crons never fire.

### All durable state lives under one host root

`LETTA_STATE_DIR` (`docker/compose.yml`) anchors every bind mount:

```
$LETTA_STATE_DIR/
  letta-home/     -> /root/.letta   settings.json, mcp-home/ (shared MCP list), global skills
  letta-data/     -> /data          conversations + agent memory (memfs git repos)
  workspaces/     -> /work          agent working directories
```

It defaults to `../..` relative to the compose file, which reproduces the original layout
beside the two repos; prod sets an absolute path. **The default is a trap in a worktree** —
`../..` from `letta-code-ui-worktrees/<feature>/docker/` resolves to the worktrees directory,
not to the real state. Set `LETTA_STATE_DIR` absolutely in `docker/.env` so a compose command
run from anywhere hits the same state, and always do container work from the main checkout.

Three named volumes remain, none precious. `bff-data` holds web-push device endpoints,
rebuildable by re-subscribing. `google-policy` and `google-creds` hold Settings → Google and
its token; they are named volumes deliberately, so the app-server cannot mount them by accident
through the state tree, and losing them only means reconnecting Google. Everything precious is in that one host directory, so a backup is a single
`tar`. `scripts/migrate-volumes-to-host.sh` moves an older install off the named volumes; it
copies and verifies but never deletes, because the memfs git history is the only record of
what an agent has learned.

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

**Never recreate `app-server` on its own.** Its network namespace is the one the other two
services live in, so `docker compose up -d app-server` recreates it and leaves `bff` and
`channel-gateway` `Exited (1)` — the whole UI goes down, and `docker ps` without `-a` shows a
healthy app-server and no sign of why. Always run `docker compose -f docker/compose.yml up -d`
unscoped; it restarts the dependents in the right order. (Rebuilding only `bff` is still fine —
nothing shares *its* namespace.)

**Channel configuration is not reachable from the web UI, by design of letta-code.** The
app-server only dispatches `channel_*` commands when `runtime.serviceCommandHandler` is set
(`message-router.ts`), and that is installed by `startChannelGatewaySupervisor` — which has
no production caller and communicates with its child gateway over **stdio**, not the
WebSocket. A `channel_*` command sent over the app-server socket is parsed, matched by
nothing, and silently dropped. They are therefore excluded from the BFF's browser allowlist:
a hang is worse than a refusal.

**The gateway is opt-in: `channel-gateway` has `profiles: ["telegram"]`** (off since
2026-09-28 — no channel was in use, and it idled at ~170 MiB). It runs only when
`COMPOSE_PROFILES` includes `telegram` (e.g. `cloudflared,telegram`; `LETTA_MODE` matches
`cloudflared` with `includes`, so extra profiles are safe). Removing the profile does **not**
remove a running gateway — `up -d` merely stops managing it — so it must be stopped with
`--profile telegram rm -sf channel-gateway`, and on prod that is a host-side step, since the
dockhand skill cannot stop containers. With no gateway, agents simply have no `MessageChannel`
tool.

**The sidecars are opt-in too: `google-mcp` has `profiles: ["google"]`, `searxng` and
`ddg-mcp` share `profiles: ["search"]`.** Prod runs `COMPOSE_PROFILES=cloudflared,google,search`.
Nothing `depends_on` them; without them the BFF's tools fail per call (web) or are not
registered (Google — but the shared-MCP-list entry follows Settings → Google, not the
container, so keep that disabled). Same removal rule as the gateway: `--profile <p> rm -sf …`.

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

  Note what that does *not* mean: it is a statement about isolation, not about how many people
  may sign in. **`ALLOWED_USERS` therefore stays a list** — in cloudflared mode it is a
  defense-in-depth mirror of the Cloudflare Access policy, which is itself a list, and it is
  what still stands if that policy is ever misconfigured (a bypass rule, "everyone in the
  directory"). Do not collapse it to a single address.
- **The allowlist is env-only, and local mode infers it.** `ALLOWED_USERS` is a comma-separated
  list, required exactly when Access is the live gate (`mode === "cloudflared" && !devBypassEmail`
  — the same condition that requires `CF_ACCESS_*`). There is no `users.json` and no `config/`
  directory: a gitignored single-file bind meant a fresh clone got a *directory* at that path and
  the BFF crash-looped on `EISDIR`. In local mode an unset `ALLOWED_USERS` makes `DEV_BYPASS_EMAIL`
  its own entry, so the bypass needs no second setting — requiring both used to produce a 403
  saying the bypass email was not in the allowlist, a self-contradiction rather than a diagnosis.
  An explicit `ALLOWED_USERS` still wins: set both to different people and `/auth/dev-login`
  refuses with that 403, which is now a real misconfiguration rather than a contradiction.
  `AllowedUser.name` was deleted with the file: nothing ever rendered it (the UI reads only
  `status.user?.email`).
- **MCP is one shared list, kept out of upstream's `settings.json`, and agents learn it from a
  skill.** Upstream MCP is per-agent only (`settings.json` → `agents[].mcpServers`), and in
  app-server mode it is not native tools: agents run `letta mcp search|tools|schema|call`
  through Bash, a fresh process that reads settings and connects per call. We used to write
  that per-agent entry and it **did not stick**: the app-server holds `settings.json` in
  memory and rewrites the whole `agents` array from that copy on any agent-setting change
  (`upsertAgentSettings` → `markDirty("agents")` → `persistSettings`; agent create, pin, memfs,
  toolset, system-prompt versioning), silently dropping what we wrote, and `reload` never
  re-reads it (`handleReloadCommand` clears only project caches), so upstream's
  `mcp-servers-info` reminder never saw it either. New entries also lacked `baseUrl`, which
  `getAgentSettings` matches (`local:/data/local-backend`), so they were invisible anyway.

  So `bff/src/mcp/` keeps the list in `/root/.letta/mcp-home/.letta/settings.json`, a file the
  app-server never loads, under the synthetic agent `agent-local-mcp-global`. The
  `mcp-servers` skill's wrapper runs `HOME=/root/.letta/mcp-home letta mcp "$@" --agent
  agent-local-mcp-global`, which is what makes the list global. The file sets
  `autoConversationTitlesRollbackApplied: true` — load-bearing: without it
  `settingsManager.initialize()` persists on every CLI call and races our writes. The skill
  (SKILL.md with the server names in its description, plus the wrapper) is rendered into
  `mcp-home/skill/` and linked with `skill_enable` (the protocol cannot delete files, so an empty
  list is `skill_disable`), on every save and every upstream connect. No reload is needed:
  skills and the file are read from disk per turn and per call. Upstream's reminder still says
  "MCP servers with available tools: None" — it only knows the per-agent list — and plain
  `letta mcp list` returns `[]`. **Both traps are named in the skill's description, not just its
  body**: a local model was seen skipping the skill, trusting the reminder, running plain
  `letta mcp list` and telling the user web search was not set up. That incident is also why web
  search is no longer an MCP server at all (see "Web search and page reading are native tools").
  A fresh install's list starts empty; nothing is seeded.
  Codex's `mcp: {inherit: true}` forwards that same empty list, so the Tasks form no longer
  offers it and `delegating-to-codex` tells agents to hand workers the wrapper instead.

  **Most turns reach these servers through native tools, not the skill: the MCP bridge**
  (`bff/src/mcp-bridge/`, the `letta-ui-mcp-bridge.mjs` mod). Four tools with small static
  schemas — `mcp_search` (keyword-ranked, marks each hit read-only or writes), `mcp_describe`,
  `mcp_call` (auto; **refuses** any tool the server does not mark `readOnlyHint` — unmarked counts
  as a write) and `mcp_call_write` (`approval: "ask"`). Search-then-call rather than one native
  tool per MCP tool keeps the per-turn prefill constant. The BFF is the MCP client (SDK, one
  session per call) for **http and sse servers only** — a stdio server's command is written for
  the app-server container, so it stays on the skill wrapper, as do subagents (no mod tools).
  `McpCatalog` caches `tools/list` per server (connect, MCP save, Google change, 10-min TTL);
  names are upstream's `mcp__<server>__<tool>`. The skill's description now says so.
  Browsers reach none of these files: `/api/mcp` reads and writes the list (an entry is a
  command line agent shells exec), and `settings.json` is no longer a readable exception.
- **letta-code's filesystem sandbox is OFF, deliberately, and the image carries no bubblewrap.**
  The app-server runs upstream's `letta/letta:<version>` (plus the Codex CLI, nothing of
  upstream's changed) with Docker's default seccomp, AppArmor and capabilities, and
  `LETTA_FS_SANDBOX: "0"`. The explicit `"0"` is
  load-bearing: unset is not off — memory subagents are sandboxed by default whenever a bwrap
  backend exists (`src/sandbox/availability.ts` `isFsSandboxEnabled`).

  It was on until 2026-09-25 (bubblewrap layered onto the image, `LETTA_FS_SANDBOX=1`, the
  cross-agent profile) and was removed after measuring what it bought, in the running container:
  - **It did not hold against a hostile agent.** bwrap as root takes its privileged path, and
    `buildBwrapArgs` passes no `--cap-drop`, so wrapped shells kept the container's full
    capability set including `CAP_SYS_ADMIN` — one `umount` removed the tmpfs mask over other
    agents' memfs. Other agents' **conversations** (`/data/local-backend/conversations`) were
    never masked at all, and `/root/.letta/settings.json` stayed writable: an `mcpServers`
    entry there is a command the app-server itself runs, unwrapped, on reload.
  - **Its price was the boundary that matters.** Making root bwrap work at all needed
    `cap_add: SYS_ADMIN` plus `seccomp:unconfined` and `apparmor:unconfined`, weakening the
    container → host wall for every agent shell.

  All agents here belong to one person, so the container boundary is the one kept. What
  remains agent-to-agent is letta-code's in-process `evaluateCrossAgentGuard`
  (`permissions/cross-agent-guard.ts`), which covers the file tools (Read/Edit/Write) and does
  not depend on the flag; shells are unconfined within the container. Real agent-to-agent
  isolation would mean one app-server container per agent — not re-enabling the flag. (Nor
  `runtime_start.workspace_sandbox`, which the UI once requested: a write-scoped profile with
  one writable root that left the agent's own memory, `/tmp` and `/root/.letta` read-only, and
  that cron- and channel-fired runtimes never got.)
- **Skills have four scopes, and none of them is per-conversation.** Discovery
  (`src/agent/skills.ts`, `src/agent/client-skills.ts`) reads, lowest priority first: bundled
  (in the package), global `/root/.letta/skills/`, agent `~/.letta/agents/<id>/memory/skills/`,
  project `<cwd>/.agents/skills/` with `<cwd>/.skills/` as a legacy fallback. Our cwd is
  `/work/<agent-id>`, so **project scope is effectively per-agent** — every conversation with
  that agent, no others. Symlinks are followed deliberately (`findSkillFiles` stats symlinked
  entries, with a realpath loop guard), so linking a skill in from a git checkout works and stays
  current.

  - **`skill_enable` always means global.** It validates `<skill_path>/SKILL.md` and then does
    exactly one thing: symlink the directory into `/root/.letta/skills`
    (`listener/commands/skills-agents.ts`). `skill_disable` only unlinks from there, so on a
    project- or agent-scoped skill it answers "Skill not found", and it **refuses a real
    directory** ("not a symlink") — so Settings → Global skills offers Disable only on a global skill whose
    root entry is a link (`link` in `/api/skills`), and not on the ones the BFF reinstalls
    itself (`managedBy`: the shipped skills and `mcp-servers`).
  - **An agent can install into any scope.** Shells are unconfined within the container (the
    sandbox is off), so an agent's shell can write `/root/.letta/skills` (global) and its own
    agent memory dir, and `skill_enable` from a shell works.
  - **Upstream publishes the list only during a turn, so the BFF discovers it itself.**
    `device_status.current_available_skills` is set in `turn-setup.ts` on the *conversation
    runtime*, and that runtime is evicted between turns (`evictConversationRuntimeIfIdle`), after
    which `buildDeviceStatus` sends `[]` — the skills list used to show skills only while the
    agent was working. No protocol command lists skills. `bff/src/skills/` re-implements
    discovery (roots, override order, the frontmatter parser, `disable-model-invocation`, the
    bundled skills hidden from local agents; memfs `skills/` counts as `agent`) and serves
    `GET /api/skills?agent_id=&cwd=`. Bundled skills live only in the app-server image and are
    read over the upstream connection (cached per connect); every other root comes from the
    BFF's **read-only mounts** of `letta-home` and `letta-data/local-backend/memfs` at the
    app-server's own paths — not the protocol, because `list_in_directory`/`get_tree` skip
    symlinks and every `skill_enable`d skill is one. `sync-upstream.sh` flags the upstream files
    this mirrors. Both views (Agent → Skills, every scope one agent sees; Settings → Global
    skills, the links) re-read on every `skills_updated` frame.
  - **`skillsDirectory` is not reachable.** It exists on `runtime-context.ts` but has no
    `runtime_start` field and no settings key, so a repo shipping its skills under its own
    convention (`.letta/skills`, `.claude/skills`) has to be symlinked into a scanned path.
  - **Upstream quirk:** `permissions/analyzer.ts` `projectRegex` matches only
    `<cwd>/.skills/<name>/scripts/`, not the canonical `.agents/skills/`. A project skill with a
    `scripts/` directory earns scoped skill-script permission rules at the *legacy* path only.
  - `runtime_start` sending neither `skill_sources` nor `preserve_skill_sources` clears
    `scopedRuntime.skillSources`, which is harmless: `getSkillSources()` then falls back to
    `ALL_SKILL_SOURCES`. Do not "fix" it into an empty list.
- **The LLM timeout bounds prefill, not generation — and there is no idle timeout.**
  `DEFAULT_LOCAL_PROVIDER_TIMEOUT_MS` (`backend/local/local-provider-timeout.ts`) is 5 minutes;
  `docker/compose.yml` raises it to 30 for the app-server. It reaches the wire as pi-ai's
  `timeoutMs` → the OpenAI SDK's `timeout`, and the SDK clears that abort timer in a `finally`
  once the fetch resolves (`openai/client.js`, `fetchWithTimeout`). **A streaming fetch resolves
  on headers**, so the clock covers connect + queueing + prompt eval and stops the moment tokens
  start. A long generation is never cut off; a stream that stalls mid-flight is never rescued.

  - Env names are derived from the provider's `localProviderNames`, most specific first:
    `LETTA_CODE_OPENAI_COMPATIBLE_TIMEOUT_MS`, `OPENAI_COMPATIBLE_TIMEOUT_MS`, then the global
    `LETTA_CODE_LOCAL_PROVIDER_TIMEOUT_MS`. A stored `timeout` on the provider record outranks
    all of them. Values parse as ms, `600s`, `10m`, or `false` to disable — **an unparseable
    value throws**, it does not fall back.
  - A timeout here **is** retryable: the SDK's `Request timed out.` matches `"timed out"` in
    `RETRYABLE_LOCAL_PROVIDER_DETAIL_PATTERNS`, so the turn retries. Contrast a GPU fault like
    `vk::Queue::submit: ErrorDeviceLost`, which classifies as `local_backend_error` and ends it.
  - `createLocalProviderFetch` in that same file looks like the enforcement point and is **not**:
    it has no callers. Do not "fix" a timeout by editing it.
  - Changing this env means recreating `app-server`, which drops the BFF's permanent upstream
    connection — see the version-bump note for what that costs.
- **Two different things are called "the system prompt", and an agent can only change one.**
  `agent.system` — what Agent → General shows — is a letta-code-**managed** preset, tracked in
  `settings.json` as `systemPromptPreset` + `systemPromptHash` + `systemPromptVersion`. On
  startup `scheduleManagedSystemPromptUpdate` (`agent/system-prompt-versioning.ts`) compares the
  hash and, while it still matches, **overwrites `system`** with the new preset text on a version
  bump. Editing it flips the agent to `systemPromptPreset: "custom"` and opts it out of every
  future refresh. No agent tool writes this field.

  What an agent rewrites when asked to change its own instructions is
  `memory/system/persona.md` in its memfs (agents created on 0.33.3+ get the flat "root MemFS"
  layout instead: `persona.md` at the repo root plus a `MEMORY.md` index; the format is detected
  by that index, so older agents keep `system/`) (`/data/local-backend/memfs/<agent-id>/memory/`, a git
  repo — `git log` there is the provenance). That block is composed into context every turn when
  `memfs: true`, and the UI surfaces it in the **Memory** tab, not Agent → General. Expect
  "I asked it to update its system prompt and the UI shows the old one" — both statements are
  true and about different fields.
- **Memory lives outside every agent workspace, and agents write it with ordinary file tools.**
  The memfs repo is `/data/local-backend/memfs/<agent-id>/memory` (`$MEMORY_DIR` in the agent's
  shell env) — never under `/work/<agent-id>`. Since letta-code 0.33 the in-process `memory`
  tool (and `memory_apply_patch`) is in **no toolset** (`tools/toolset-catalog.ts`); its code
  still exists but no agent can call it. Agents use plain `Edit`/`Write`/`Bash` on
  `$MEMORY_DIR` (the file tools pass the cross-agent guard for the agent's own memory; shells
  are unconfined), and the repo's `pre-commit`/`post-commit` hooks validate frontmatter.
  Incidental upkeep and post-turn git conflict repair go to a **background memory worker**, a
  subagent registered like any other (`registerSubagent`) — so it shows in
  `update_subagent_state`, and `push/turn-watcher.ts` holds the "finished" push until it ends.
  Old transcripts still contain `memory` calls, which is why `tool-summary.ts` keeps the case.
  `letta memory` (the CLI) has status/diff/backup/export/pull but **no write verb** — its own
  help says "use git commands" — so an agent that goes looking there finds nothing and
  concludes memory is unwritable.
- **Stop cannot actually cancel a local generation, and the app-server says it did.**
  `abort_message` → `handleAbortMessageInput` (`listener/control-inputs.ts`) →
  `turnLifecycle.requestCancellation()`, which **synchronously** flips the lifecycle to
  `cancelling` — so `is_processing` goes false at once — and then emits
  `emitInterruptedStatusDelta`, the "Interrupted" line. All of that is optimistic: it happens
  before anything has stopped.

  The abort reaches `stream.ts` → `abortStreamController(stream)` → `stream.controller.abort()`,
  and **that controller is wired to nothing.** `backend/dev/provider-turn-executor.ts`
  (`createProviderLettaStream`) mints `new AbortController()` whose signal is never passed
  anywhere — the provider event iterable was already built without it — and
  `backend/local/local-executor-factory.ts` constructs `new PiStreamAdapter({…})` with **no
  `abortSignal`**, so `pi-stream-adapter.ts` never puts a `signal` on the HTTP request.
  `HeadlessBackend` stores that dangling controller as the run's controller and
  `persistExecutorStream` passes it straight through, so `cancelRun` → `controller?.abort()` is
  a no-op against llama.cpp.

  Consequence: the turn can only end when the model's **next chunk** arrives, because
  `stream.ts` checks `abortSignal.aborted` only *inside* `for await (const chunk of stream)`.
  Press Stop during prefill and the loop stays parked while llama.cpp finishes the whole
  response — the reported "I pressed Stop, got Interrupted, and the LLM kept going".

  Two more shapes of "Stop did nothing": `handleAbortMessageInput` returns early with **no
  frames at all** when there is no active turn and no pending approval — which a *second* press
  always hits, since the lifecycle is already `cancelling` — and `message-router.ts` answers a
  stale runtime with `success: false, error: "Runtime is no longer active"`. Both are visible
  only in `abort_message_response`, so the UI **must** use `request()` and not `send()` for
  abort. `use-conversation.ts` does, and renders its own honest "Stopping" line for the gap.
  Fixing the cancellation itself needs an upstream change; it cannot be done from here.
- **`tool_return_message` has two shapes, and one call emits several frames.** A live delta
  carries the singular `tool_call_id`/`status`/`tool_return` fields **and** a `tool_returns[]`
  array (`normalizeToolReturnWireMessage`, `listener/interrupts.ts`); history persists only the
  singular ones. `tool_returns` is absent from `protocol_v2.ts`, so **typecheck cannot catch
  drift here** — it is a behavioural item, like `connection-lifecycle.ts`.

  One Bash call produced two frames in a live capture: a `synthetic-tool-return-stream-<id>`
  snapshot while the command ran, then a `synthetic-tool-return-<uuid>` canonical one — upstream
  says so outright ("Client-executed tools emit repeated tool_return_message snapshots while
  running", `app-server-openai-tools.ts`). Their ids differ, they carry no `otid`, and every
  local-backend stream chunk gets a fresh `letta-msg-N` from `local-store.ts` `createStoredChunk`
  anyway. So keying a return the ordinary way drew one Result row per snapshot, which a reload
  then collapsed. `web/src/lib/messages.ts` keys them `return:<tool_call_id>` in both paths.
  The later frame also carries the **corrected** status: the running snapshot reports `success`
  even for a command that went on to fail. (The store persists the snapshot's status, so a
  failed command still reads as a success after a reload — upstream, not ours.)
- **Every tool call arrives as `approval_request_message`**, approved or not. The real approval
  prompt is the `control_request` frame that drives `ApprovalSheet`; the message is just the
  call record, so the transcript labels it "Tool".
- **Provider errors reach the transcript as JSON.** `local-provider-errors.ts`
  `localProviderErrorDetail` joins the error message with `JSON.stringify()` of whichever of
  `responseBody`, `data`, `body`, `detail`, `code` the failure had, and the terminal `loop_error`
  carries that detail — so a llama.cpp fault arrives as a sentence followed by its raw HTTP body.
  `splitErrorDetail` in `web/src/lib/messages.ts` lifts the payload's own `message` for the
  headline and keeps the body behind a disclosure.
- **Agent web apps: ports 3000-3099, taught by a skill.** A server an agent starts runs inside
  the app-server container, reachable from the LAN only on the published range 3000-3099
  (`AGENT_APPS_BIND`, default `0.0.0.0`). Agents learn it from the global skill
  `docker/agent-skills/serving-web-apps` — a skill because letta-code lists every skill's name
  and description in context each turn, so the rule reaches every agent, cron and channel
  turns included, without touching anyone's memory. It ships in the **bff image** and
  `bff/src/agent-skills.ts` writes it into `/root/.letta/skills/` over the upstream connection
  on every connect (`write_file` creates the directories), overwriting any agent edit.
  **Never bind-mount repo files into a service:** Dockhand runs compose inside its own
  container, so a relative bind source (`./…`) names a path that does not exist on the host
  and the daemon mounts an empty directory — silently. Builds are fine (the context is
  streamed); anything from the repo must travel in an image. `AGENT_APP_PORTS` and `AGENT_APP_HOST` (the address to put in URLs, from
  `docker/.env`) are in the app-server env for it. No auth in front of those ports, and the
  processes die with the container. The skill's frontmatter `name` must match its directory.
- **Codex workers: letta-code runs them, a shim makes them fit this container.** Since 0.33,
  `Task` / `launch_subagent` accept `subagent_type: "codex"` and spawn `codex app-server
  --stdio` from PATH (`tools/impl/external-coding-agent.ts`, `codex-app-server.ts`). Our
  app-server image (`docker/codex/Dockerfile`) installs the real CLI under `/opt/codex` and puts
  `docker/codex/codex-shim.mjs` on PATH as `codex`. Upstream unmodified. What the spike established
  (2026-09-27, Codex 0.157.1, measured in the container):
  - **letta hard-codes `sandboxPolicy: workspaceWrite` on every `turn/start`, and Codex builds
    that with bubblewrap,** which Docker's default seccomp (no user namespaces) and then its
    AppArmor (no mounts) both refuse — every command fails, and the model just says so.
    Relaxing both is the trade-off rejected above for letta's own sandbox, and Codex's
    deprecated `use_legacy_landlock` still requires bwrap. Codex's managed
    `requirements.toml` `allowed_sandbox_modes` *rejects* a disallowed mode rather than
    downgrading it. So the shim rewrites that one field to `{type: "externalSandbox"}` — the
    container is the sandbox — and passes every other byte through. A worker therefore has the
    same reach as an agent shell: the whole container, other agents' memory included. Under
    `externalSandbox` Codex enforces nothing, network included, so the UI offers no network
    toggle (it would only be a hint to the model).
  - **The preflight is `codex --version`** (since 0.33.3; it was `codex login status`, which a
    custom provider never passes). The first real turn is now what proves the provider answers.
    The BFF still writes an API-key `auth.json` with a placeholder key — no longer needed by the
    preflight, harmless, and an OpenAI-provider credential no worker uses. With workers disabled
    the shim fails the preflight, so the task reports "Codex executable is not ready: <our
    disabled message>".
  - **Configuration is Settings → Codex workers, owned by the BFF** (`bff/src/codex/`). It stores
    `letta-ui.json` in `CODEX_HOME=/root/.letta/codex` (persisted, so threads survive recreates
    and `SendAgentMessage` follow-ups can resume them) and renders `config.toml` (provider
    `letta-ui`, `wire_api = "responses"` — the endpoint must serve `/v1/responses`, which
    llama.cpp does) and `auth.json` from it, on every save and every upstream connect. The API
    key never goes back to a browser. `letta-ui.json` is also the switch: the shim refuses to
    run until it says `enabled`, and that refusal is what a task reports.
  - **letta keeps only a worker's final message.** The full run lives in Codex's rollout,
    `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`, appended live. Thread
    ids are UUIDv7, so the day directory comes from the id. `GET /api/codex/runs[/:threadId]`
    parse it (`codex/rollout.ts`); the viewer polls while a run is going. The task
    notification carries `agent_id=codex_<thread id>` (success only), which is how a transcript
    entry links to its run. The live `update_subagent_state` snapshot does **not** carry it
    (`agent_url` stays null for external workers), hence the "Codex runs" list in Tasks.
  - **cwd is whatever the parent runtime's is:** `/work/<agent-id>` for UI conversations, but
    `/work` for a runtime started without a cwd (cron- and channel-fired ones).
  - Codex also fetches its plugin marketplace from GitHub on start (`$CODEX_HOME/.tmp/plugins`)
    — not model traffic, but not nothing.
  - Upstream drift to watch: the shim depends on letta's `turn/start` shape and the preflight
    command; re-verify both on every letta-code or Codex bump (`CODEX_VERSION` is pinned in
    compose, never floated).
- **Provider connection state is `connected.is_connected`**, not `connected.connected`.
- **Settings are split by scope, and the split is the UI's only statement of it.** The **Agent**
  tab (`web/src/tabs/AgentTab.tsx`) holds what belongs to the selected agent: General (name,
  model, base system prompt, delete), Secrets, Reflection, and the Skills it sees. **Settings**,
  the top bar's gear (`components/GlobalSettings.tsx`, full screen; wrapping chips with short
  names on a phone, the grouped list beside the section on desktop), holds what every agent shares — providers, web search, MCP servers,
  Google, Codex workers, global skills — plus this device's notifications and an About. A new
  setting goes where its backend key is: keyed by `agent_id` → Agent tab; a BFF file or an
  app-server-wide command → Settings; `runtime` scope → next to the conversation (composer).
- **Web search and page reading are native tools, `web_search` and `fetch_webpage`, installed
  as a letta-code mod.** Upstream's own tools of those names are Letta-*server* tools, which our
  local backend (`serverSideToolManagement: false`) cannot have. A **mod** is upstream's supported
  way to add a client tool: a file in the app-server's global mods directory `/root/.letta/mods/`
  whose default export calls `letta.tools.register(...)` (`src/mods/mod-sources.ts`,
  `mod-engine.ts`). Listener turns get mod tools whatever the toolset preference
  (`tools/manager.ts` `capturePreparedToolExecutionContext`) — chats, crons and channel turns
  alike. **Subagents do not** (they run a providers-only capability profile), nor do Codex workers.

  - **Mods are thin; the BFF does the work** (`bff/src/internal-tools/`, shared by every mod we
    ship). `renderToolsMod` emits plain ESM (mods cannot import npm packages) whose tools POST
    their args to `http://127.0.0.1:8080/internal/tools/<name>`. That route is handled in
    `Bun.serve` before Hono and answers **only loopback clients** (`internal-tools/http.ts`) —
    i.e. the app-server namespace (mods, agent shells, the gateway), which can reach every
    sidecar and the internet anyway; a browser (published port, cloudflared) gets a 404. The
    first web-tools mod's `/internal/web-tools/{search,fetch}` paths stay as aliases. Each tool
    is `approval: "auto"` (never prompts) or `"ask"` (`requiresApproval` + `approvalPolicy:
    "ask"`: Standard/Strict prompt, Unrestricted runs — `permissions/checker.ts`). Reads are
    `auto`; an `ask` tool in an unattended cron turn under Standard mode waits for an approval.
    Three mods: `letta-ui-web-tools.mjs`, `letta-ui-google-tools.mjs`, `letta-ui-mcp-bridge.mjs`.
  - **Search:** the `searxng` sidecar (`docker/searxng`, pinned `SEARXNG_VERSION`, settings baked
    into the image *outside* `/etc/searxng` — that path is a declared VOLUME and compose carries
    an anonymous volume across recreates, so a settings change there would never land). Engines
    were probed from a residential IP: bing, brave and yahoo answer; duckduckgo and qwant return
    CAPTCHA; mojeek is inactive upstream (proof-of-work CAPTCHA); google needs JavaScript. When
    SearXNG is down or every engine failed, the BFF falls back to ddg-mcp's `search`, whose
    browser-TLS fallback SearXNG's duckduckgo engine lacks.
  - **Pages:** ddg-mcp's `fetch_content` in markdown mode (`web-tools/ddg.ts`, MCP SDK, one
    session per call). The sidecar keeps the rate limiter (30 searches / 20 fetches a minute) and
    page cache, and fetches from its own container, not the BFF's. `DDG_REF_URL_THRESHOLD: "0"`
    so fallback results carry real URLs, not `ref://` tokens. The Host header must stay
    `ddg-mcp:8000` (its `--allowed-hosts` DNS-rebinding guard).
  - **Loading: no file watch.** Global mods load on the first client connection (the BFF's,
    `app-server.ts` `getStartupReady`) and again only on `execute_command reload`, which needs an
    agent runtime (`listener/commands.ts`). So `resyncMods` (index.ts) renders all three mods,
    writes only those that differ (`internal-tools/install.ts` `syncMods`) and sends **one**
    `reload` in the first agent's `default` conversation — retried every 30 s while no agent
    exists. It runs on connect, on a Settings → Web search or → MCP servers save, and 4/12/30 s after any
    Google change. An app-server restart needs no reload: the files are already there.
  - **Settings → Web search** (`/api/web-tools/*`, `/root/.letta/web-tools/letta-ui.json`): a switch
    (off renders a mod that registers nothing — the protocol cannot delete a file), backend
    status, a test search, and mod load errors from letta-code's
    `/root/.letta/mods/diagnostics/latest.json` (errors only — a clean load writes nothing).
  - **duckduckgo left the shared MCP list** in a one-time migration (`retireSeededDdgMcp`,
    recorded as `mcpDdgRetired`), so a user who adds it back keeps it.
- **Google (Gmail / Calendar / Tasks) is a sidecar whose access no agent can change.** Agents
  reach `http://google-mcp:8000/mcp` (`docker/google-mcp`: taylorwilsdon/google_workspace_mcp,
  pinned `WORKSPACE_MCP_VERSION`, under `supervisor.py`), listed in the shared MCP list while it
  serves. Reaching it is not the control — agent shells reach everything. What it may do is
  fixed in two places no agent can touch:
  1. **The token's OAuth scopes.** The BFF runs the consent (`bff/src/google/`), asking for
     exactly the levels' scopes, never `include_granted_scopes`. Invariant: the token never
     holds a scope the policy does not want — narrowing a level **revokes** it (Google would
     otherwise keep honouring the wider grant), a consent that comes back wider is revoked
     unkept, and changing the OAuth client drops it. **A revoke is grant-wide:** Google removes
     the app's access to that account, killing every refresh token it issued this client —
     including one minted a second ago. So a reconnect of the *same* account replaces the file
     and revokes nothing (revoking the old token once killed the new one on prod 2026-09-28: the
     first tool call after a widening reconnect got `invalid_grant`); only another account's
     token is revoked, and a rejected too-wide consent also drops the stored same-account token.
     Widening waits for a reconnect; meanwhile
     the sidecar runs at what the grant covers (`coveredPermissions`, which also handles scopes
     unticked on Google's consent screen).
  2. **workspace-mcp's `--permissions`**, which filters its tool list by the same scopes.
     `bff/src/google/policy.ts` mirrors its level → scope table (`auth/permissions.py`) —
     re-verify on every version bump. The supervisor also removes `start_google_auth` (else any
     agent can mint a consent link), sets `WORKSPACE_MCP_DISABLE_LOCAL_FILES=true`
     (**load-bearing**: without it tools accept server-side `file_path`, and an agent could mail
     itself `/creds`), and launches from a clean env so no `WORKSPACE_MCP_*` fallback widens it.

  Both live on the `google-policy` / `google-creds` volumes, mounted by `bff` and `google-mcp`
  **only — never mount them into `app-server` or `channel-gateway`.** The token file is
  workspace-mcp's own format (`<email>.json`, `LocalDirectoryCredentialStore`); single-user mode
  uses the first file it finds, so connecting clears the directory first. The supervisor polls
  `sidecar.json` and restarts on change; disabled means nothing listens.

  **Dev bypass is the hole.** Agent shells share the BFF's namespace, so in dev-bypass mode they
  can `curl 127.0.0.1:8080/auth/dev-login` and hold a session. Google writes are therefore
  refused whenever `DEV_BYPASS_EMAIL` is set (`googleWritesAllowed`) unless
  `GOOGLE_ALLOW_DEV_BYPASS=true`. Every **other** setting (MCP list, Codex, agents) is still
  writable that way in local mode — a known gap, not fixed here. Behind Cloudflare Access an
  agent cannot mint a session. The OAuth callback is gated by its single-use `state`, not the
  cookie, so a `GOOGLE_OAUTH_REDIRECT_URI` on another origin (localhost) works.

  Limits by design: one policy for every agent (per-agent would need per-agent containers), and
  allowed tools still combine — Calendar `full` can invite any address, which mails them even
  with Gmail read-only, and email content is prompt-injection input.

  **A token Google stops accepting is kept, marked lost — never silently dropped.** Tokens die
  outside our control (revoked in the Google account, a password change, an unpublished consent
  screen's 7-day limit). workspace-mcp's error then tells the model to run `start_google_auth`,
  which we removed, so a model went hunting for it and gave up. Now `google/lost-access.ts`
  recognises the auth failure in both the curated tools and `mcp_call` on the Google server,
  records `grant.lostAt` (`markLost`) — only on Google's own refusal (`invalid_grant`,
  `Token Expired/Revoked`, no credentials): workspace-mcp appends "LLM: Try 'start_google_auth'"
  to **every** 403, and matching that marked access lost on prod when the real error was
  `accessNotConfigured` (Calendar and Tasks APIs switched off in the OAuth client's Cloud
  project). That case gets its own answer — the API, the project, a link to its switch in the
  API library, "do not reconnect" — and every other Google error just loses the misleading
  hint (`googleErrorAnswer`). For a real loss it answers the agent with what to tell the user plus two
  links built on `PUBLIC_ORIGIN`: `/api/google/reconnect` (GET, session- and write-gated: mints a
  consent `state` and 302s straight to Google — one click from chat) and `/?settings=google`
  (the SPA opens Settings on that section; `lib/settings-link.ts`). The grant stays, so the tools
  stay registered and keep giving that answer, and Settings → Google leads with "Access lost for
  …" and a Reconnect button. Opening it also asks Google (`checkIfDue`, at most every 5 min), so
  it shows a loss nobody has hit yet — a grant already marked lost is re-checked too, so a
  mistaken mark clears itself. A refresh that works again clears `lostAt`. The skill
  wrapper path (stdio, subagents) still gets workspace-mcp's raw text.

  **Agents use Google through native tools, not the skill** (`bff/src/google/tools.ts`, the
  `letta-ui-google-tools.mjs` mod): `gmail_search`, `gmail_read`, `calendar_events`,
  `calendar_freebusy`, `tasks_list` (reads, never ask) and `gmail_send`, `gmail_draft`,
  `calendar_event`, `tasks_update` (writes, `approval: "ask"`). Each is a compact schema mapped
  onto one workspace-mcp tool — its own schemas are large (`manage_event` has 32 parameters) and
  would ride in every turn's prefill. **Access control is unchanged:** a curated tool is
  registered only if the tool it maps to is in the sidecar's current `tools/list`, which
  `--permissions` and the granted scopes already filter, so read-only Gmail never shows
  `gmail_send`. `user_google_email` is left out: `--single-user` defaults it (and the bridge hides
  it from schemas). The mappings are pinned by a recorded `tools/list`
  (`bff/src/google/fixtures/workspace-mcp-<version>.{full,readonly}.json`, captured by running
  the pinned image with `--single-user --permissions …` and a dummy OAuth client — listing needs
  no token) and `google/tools.test.ts` checks every mapped tool, argument and read/write marking
  against it. **Refresh the fixture on every `WORKSPACE_MCP_VERSION` bump.** Everything else
  Google offers (labels, filters, focus time…) is reachable through the MCP bridge below.
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
- **Pinning and archiving an agent are not in the protocol, so both are ours.** letta-code
  keeps a pinned list in `settings.json` for its CLI picker, but the app-server only sets it at
  creation (`create_agent.pin_global`), and it has no agent archive — its `hidden` flag marks
  subagents (and hidden agents leave `agent_list`), so it must not be borrowed. The BFF keeps two
  id lists (`bff/src/agents/id-list.ts`: `pinned-agents.json`, `archived-agents.json` on
  `bff-data`; `GET /api/agents/flags`, `PUT /api/agents/{pins,archived}/:id`; archiving also
  unpins). Archive only hides: crons, memory and conversations carry on. One `AgentMenu` (Edit,
  Pin, Archive, Delete) serves the phone switcher (opening above its ⋯) and every row of the
  desktop sidebar's agent list (opening below); it is fixed to the viewport because both agent
  lists scroll in boxes of their own, which clip an absolute menu, and closes itself on Back,
  Escape and presses elsewhere. `use-agents` returns `agents` pinned-first; both lists hide
  archived agents behind "Show archived agents (N)".
- **The desktop sidebar is two lists with one row language, told apart by where they sit.**
  There is no agent dropdown: agents are rows (`.agent-row`: round avatar, name, conversation
  count or a responding dot, ⋯) on a panel of their own (`.sidebar-agents`, `--surface-2`,
  capped at a third of the height); conversations stay on the sidebar's background with dates.
  Both mark the open row with a 3px left bar. Counts for other agents come from
  `useAgentStats`, fetched only at the desktop width (`useWide`) — the sidebar stays mounted,
  hidden, on a phone. ui-check reads the open agent from `.agent-row.active[data-agent-id]`.
- **`create_agent` presets** are exactly `memo | tutorial | blank | linus | kawaii`. There is
  no `default`.

## Upstream sync

`bun run sync-upstream v<version>` — fetches upstream tags, reports protocol and behavioral
drift between the checkout's current tag and the target, checks the target out (detached),
re-pins every version site to the new release, and typechecks.

Protocol drift shows up two ways:
1. **Typed** — `web/` and `bff/` import from `@letta-ai/letta-code` (pinned to the npm release
   matching the running image), so `bun run typecheck` fails on any breaking protocol change.
2. **Behavioral** — types will NOT catch these; the sync script flags changes to:
   - `src/websocket/listener/connection-lifecycle.ts` — the turn-cancellation semantics above.
   - `src/channels/gateway-supervisor.ts` and `src/channels/gateway-local.ts` — if the gateway
     ever gains `--ws-auth`, the shared-network-namespace workaround below can be dropped.
   - `src/types/background-process-protocol.ts` — `readBackgroundProcesses` hand-parses these
     and drops unknown kinds. 0.33 made `workflow` a native kind (it used to arrive as `bash`
     with a `workflow_N` id); a missed new kind vanishes from the Tasks tab without a type error.
   - `src/tools/toolset-catalog.ts` — which tools agents actually get. 0.33 removed `memory`,
     `MultiEdit`, `TodoWrite` and the Codex shell aliases, and added `Wake` (durable timed
     follow-ups stored in the local cron scheduler — so they fire only because the BFF's
     permanent connection keeps the scheduler running, and they appear in `cron_list`).
     0.33.3 added `WatchPR` (a `monitor` background process with `source:
     "github_pull_request"`). It shells out to `gh api`, so the app-server image carries the
     GitHub CLI (pinned `GH_VERSION`, installed from the release tarball — the base image has
     no apt, gzip or git). Its login is in `GH_CONFIG_DIR=/root/.letta/gh`, persisted and
     readable by every agent shell; setup is in `docker/README.md`.

### Version pinning

**Sync to a published release tag, never `main`:** the script accepts only `v<x.y.z>`. Everything the stack
runs comes from a **published artifact**: the images are `letta/letta:$LETTA_CODE_VERSION` from
Docker Hub, and the protocol types are `@letta-ai/letta-code@<v>` from npm. A checkout sitting one
commit past a tag has nothing to pin to, and quietly stops being the code the app-server runs.
`sync-upstream.sh` now asserts both artifacts exist before re-pinning.

**The version literal lives in six tracked places and they must move together:**

| File | Form |
|---|---|
| `docker/compose.yml` | `LETTA_CODE_VERSION: ${LETTA_CODE_VERSION:-<v>}` — app-server build arg (its `FROM`) |
| `docker/compose.yml` | `image: letta-app-server:${LETTA_CODE_VERSION:-<v>}-codex…` — app-server local tag |
| `docker/compose.yml` | `image: letta/letta:${LETTA_CODE_VERSION:-<v>}` — channel-gateway |
| `package.json` | `"@letta-ai/letta-code": "<v>"` |
| `bff/package.json` | same |
| `web/package.json` | same |
| `docker/.env` | `LETTA_CODE_VERSION=<v>` — gitignored, so it drifts unseen |

`scripts/check-version-pin.ts` asserts they agree and runs first in `bun run verify`. Its
app-server patterns are fenced to that service's block: a plain lazy match ran on into
channel-gateway's image line once the app-server stopped naming `letta/letta` directly.
`docker/.env` is reported but never fatal — it cannot be fixed from a fresh clone.
`sync-upstream.sh` rewrites all of them for you (its sed replaces every
`LETTA_CODE_VERSION:-…}`).

**The trap that hides a stale pin:** a shell `LETTA_CODE_VERSION` outranks `docker/.env` in
Compose's precedence order. That is how `.env` sat at `0.30.27` through the whole `0.30.29`
cycle without anyone noticing. The pin check now prints a warning for exactly this case.

**A version bump is a full redeploy.** `docker compose -f docker/compose.yml up -d --build` —
rebuilds the app-server image on the new base, pulls the new channel-gateway image and
rebuilds bff. This is the documented exception to "Only `bff` is rebuilt
in step 4" under Definition of done; that note governs ordinary UI and BFF changes, this one
governs version bumps. Recreating `app-server` drops the BFF's permanent upstream connection,
so any in-flight turn is lost and the cron scheduler and Telegram gateway restart on the BFF's
reconnect.

## Git workflow

Worktrees per feature, feature branches, fast-forward merge to `main`
(`git merge --ff-only`, no merge commits), no PRs. Rebase the feature branch onto `main`
first if it isn't already a fast-forward.

## Definition of done

Work is **not done**, and must not be reported as done, until every line below passes.
This list exists because a change was once reported as complete when it had been
typechecked and built but never committed, never merged, and never deployed — the
container was still serving the previous bundle, and only the user noticed.

Passing typecheck is not done. Passing tests is not done. **Running in the container is done.**

1. **`bun run verify` green** — lint, typecheck, tests, build. Fails fast; later stages
   do not run once one fails.
2. **Committed** on a feature branch and fast-forwarded into `main`
   (`git merge --ff-only`).
3. **Worktree cleaned up** — `git worktree remove <path>`, feature branch deleted.
4. **Docker rebuilt from `main`** —
   `docker compose -f docker/compose.yml build bff && docker compose -f docker/compose.yml up -d bff`.
   The `build` is not optional; see the note below.
5. **`bun run deploy-check` green** — asserts the tree is clean and on `main`, that the
   bundle the container serves is byte-identical to the one in `web/dist`, and that
   `/readyz` and the upstream app-server connection are healthy.
5b. **`bun run ui-check` green** for any change touching `web/` — drives headless
   Chromium at phone and desktop widths and asserts what unit tests cannot see:
   nothing clipped off-screen, the composer controls present, sheets opening and
   closing, breakpoint behaviour. Screenshots land in `.ui-check/`. It needs the
   stack running, which is why it sits here and not inside `verify`.
6. **`bun run smoke` green** when the change touches BFF session, protocol or settings
   paths. Not part of `verify`: it needs a live stack, it needs at least one agent to
   exist, and it mutates real state (writes `smoke-probe.md` into the agent cwd, edits
   and restores the shared MCP list, creates and deletes a cron task).
7. **Released to prod — pushed to `origin`, then redeployed with Dockhand — but stop and ask
   first.**

### Stop before releasing to prod

**Never `git push` and never redeploy prod without asking, every time.** After merging to
`main` and passing steps 1–6, halt and ask for explicit confirmation of the full release. Standing
approval does not carry over: a yes on one change is not a yes on the next one, and "go ahead"
given before the preflight was shown is not a yes either.

Pushing is the one step that leaves this machine, and `origin` is the only copy of this
project that is not on one laptop — so it matters, and so it is worth a human deciding.
It comes last, after `deploy-check`, so nothing reaches `origin` that has not been proven
to run in the container first.

**Prod is deployed from `origin`, not from this machine.** Dockhand (http://192.168.1.24:3000)
builds the stack from `dmarchevsky/letta-code-ui` `main` at the moment of the deploy, so the push
must land first and an unpushed commit never reaches prod. Use the `dockhand-deploy` skill
(`~/.claude/skills/dockhand-deploy/`) for every step — `plan`, `deploy --confirm`, `verify` — never
ad-hoc API calls and never the Dockhand stop/down/delete/exec endpoints.

The confirmation question must **name the target exactly** and show the preflight, so the user is
approving a specific thing:

| | Prod value |
|---|---|
| Dockhand environment | `letta` (id 7, host `172.31.0.102`) |
| Stack | `letta-code-ui-prod` (git stack id 8, compose `docker/compose.yml`) |
| Containers | `letta-code-ui-prod-app-server-1`, `-bff-1`, `-channel-gateway-1`, `-cloudflared-1` |

Re-read environment and stack from `dockhand.sh stacks letta` before asking — never from memory,
never inferred from a similar name (`duckduckgo` alone exists in three environments). If they do
not match the table, stop and ask rather than deploying.

The question also states: the commit range (`plan` output: deployed commit → `origin/main`),
whether `docker/compose.yml` changed, **which containers will be recreated**, and the previous
deploy's duration. Call out an `app-server` recreate explicitly — Dockhand runs an unscoped
`compose up`, so any image or compose change to it recreates it, and that kills every in-flight
turn with no drain (the BFF's shutdown drain covers only `bff`; see "A `bff` redeploy is the one
time the connection does close"). A cron or Telegram turn does not show in the BFF log, so the
log alone cannot prove nothing is running.

Order, once confirmed: `git push origin main` → `dockhand.sh deploy letta letta-code-ui-prod
--confirm` → `dockhand.sh verify letta letta-code-ui-prod --since <printed time>` → the BFF log
must show `Upstream connected: letta-code <pinned version>`. A version other than the pin means
Dockhand's stored stack variables override it. On any failure, stop and report — no retry, no
rollback, no restart without the user choosing it.

`origin` is `dmarchevsky/letta-code-ui`, private, and was empty until the first push. There
is no `main` upstream to track on a fresh clone — the first push of a branch needs
`git push -u origin main`. `.gitignore` covers `docker/.env` and `docker/secrets/`; neither is
tracked, and no secret values are in history. Re-check that before pushing anything new that
touches configuration.

Only `bff` is rebuilt in step 4 — it is the only service carrying our code. Recreate
`app-server` or `channel-gateway` only when `LETTA_CODE_VERSION` or their compose config changes,
and `ddg-mcp` only when `DDG_MCP_VERSION` or `docker/ddg-mcp/` changes (it shares no namespace,
so `docker compose -f docker/compose.yml up -d --build ddg-mcp` is safe on its own). The same
goes for `google-mcp` with `WORKSPACE_MCP_VERSION` / `docker/google-mcp/`, and `searxng` with
`SEARXNG_VERSION` / `docker/searxng/`.

**`web/dist` is baked into the bff image, never mounted.** `bff.Dockerfile` builds the SPA
in its `web-build` stage and copies the result into the runtime image; the BFF's only mounts
are the `bff-data` volume and read-only views of the state (`/work`, `/root/.letta`, the memfs
root — for file mtimes and skill discovery) — it takes no configuration from disk at all.
So `docker compose up -d` on its own will happily serve a months-old UI, and a local
`bun run build` changes nothing the container sees. That is the trap step 5 catches: it
compares the served `assets/index-*.js` name against the local one.

Lint policy: `bun run lint` fails on Biome **errors** only. Warnings are visible but do not
block — a handful are load-bearing (see the comments in `biome.jsonc` for why
`useExhaustiveDependencies` is a warning here: satisfying it would reintroduce the unbounded
app-server request loop that `use-session.ts` documents).

## Commands

| Command | What it does |
|---|---|
| `bun run verify` | **The gate.** version-pin → lint → typecheck → test → build, fail-fast |
| `bun run deploy-check` | Asserts the running container serves the merged code, and is healthy |
| `bun run ui-check` | Layout/interaction assertions in a real browser; screenshots to `.ui-check/` |
| `bun run lint` | Biome check (errors fail, warnings do not) |
| `bun run format` | Biome check with safe fixes applied |
| `bun run typecheck` | Typecheck both packages — the protocol-drift detector |
| `bun run test` | `bun:test` unit tests |
| `bun run build` | Builds the SPA into `web/dist` (runs `tsc --noEmit` first) |
| `bun run dev` | BFF + Vite dev server |
| `bun run smoke` | Live acceptance suite against a running stack — mutates state |
| `bun run sync-upstream v<x.y.z>` | Move the upstream checkout to a release, report drift, re-pin |
| `bun run check-version-pin` | Assert every letta-code version literal agrees (runs inside `verify`) |
| `bun run migrate-state` | One-shot: copy the old `letta-home`/`letta-data` named volumes onto the host |
| `docker compose -f docker/compose.yml build bff` | Rebuild the BFF image — **required** to ship UI changes |
| `docker compose -f docker/compose.yml up -d` | App-server + BFF; `cloudflared`, `google-mcp` (`google`), `searxng` + `ddg-mcp` (`search`) and `channel-gateway` (`telegram`) only with their profiles |
| `git push origin main` | Release, part 1 — **ask for confirmation first, every time** |
| `~/.claude/skills/dockhand-deploy/dockhand.sh plan letta letta-code-ui-prod` | Prod preflight: commits, compose diff, what gets recreated (read-only) |
| `… deploy letta letta-code-ui-prod --confirm` | Release, part 2 — prod redeploy via Dockhand, same confirmation as the push |
