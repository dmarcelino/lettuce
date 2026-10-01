# lettuce — Project Guide

Self-hosted personal assistant: a local Letta agent (memory, crons, skills) driven from a
mobile-first web UI we own end to end. No Letta Cloud, no cloud LLM providers.

Incident narratives and long upstream walkthroughs live in `docs/upstream-notes.md`;
pointers below read `see docs/upstream-notes.md#anchor`.

## Workspace layout

```
/home/dima/work/letta/
  letta-code/      plain clone of letta-ai/letta-code at the pinned release tag — read-only
  lettuce/         this repo — everything we own (the app is **Lettuce**; the local checkout
                   dir may still carry the old `letta-code-ui` name until renamed)
```

**The upstream clone is dev tooling, not a build input.** Nothing in `letta-code/` is compiled
into any image and nothing outside `lettuce/` is in any build context. The channel-gateway runs
upstream's published `letta/letta:<version>` as-is; the app-server runs a thin image built
`FROM` it that only adds the Codex CLI and our `codex` shim (`docker/codex/`, see "Codex
workers"); the UI consumes `@letta-ai/letta-code` from npm. The checkout exists so
`sync-upstream.sh` can diff it and so you can read the source (the npm package ships only
`dist/`). A prod host needs only `git` and `docker` — no `bun`, no letta-code checkout.

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

Why: `letta-code/src/websocket/listener/connection-lifecycle.ts` (`cleanupListenerConnection`)
— when a connection closes and no other *subscribed* connection remains for that
`(agent_id, conversation_id)` scope, the app-server calls `turnLifecycle.requestCancellation()`
and **kills the in-flight turn**, drops that connection's queued messages, rejects its pending
approvals and kills its terminals. A phone backgrounding a tab drops its socket within seconds;
because the BFF owns the connection, none of that cleanup ever runs.

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
`bff/src/shutdown.ts` holds SIGTERM until `ActivityTracker` reports no turn in progress, up to
`SHUTDOWN_DRAIN_TIMEOUT_SECONDS` (default 9 min), while still serving browsers; a second signal
skips the wait. `stop_grace_period: 10m` in `docker/compose.yml` is what lets it — Docker's
default 10 s SIGKILLs the drain — and must stay above the drain timeout. Both must also fit
inside Dockhand's `compose up` timeout: 900 s (`COMPOSE_TIMEOUT`), image build included.
Without the drain the cancel cannot reach llama.cpp, and the failure signature is an error
push exactly five minutes after a BFF restart (`BUSY_RUN_WAIT_TIMEOUT_MS`,
`Conversation is still busy because run … remained active after 300000ms`) — full story:
docs/upstream-notes.md#bff-redeploy-drain.

**Turn errors are live-only upstream, so the BFF keeps them.** A failed turn reaches clients as
a `loop_error` delta and `turn_finished.error`; neither is written to the message store, so
`conversation_messages_list` cannot show it. `bff/src/session/turn-errors.ts` records the last
few per scope (in memory), served at `GET /api/turn-errors`, and `mergeTurnErrors`
(`web/src/lib/messages.ts`) slots them back into the rebuilt transcript by date. The failure
push also carries the error's first line.

**Token usage is live-only too, so the BFF keeps it as well.** The context gauge's numbers come
from one `usage_statistics` stream delta per model step (`turn_finished.usage` exists only with
CLI `execution_settings`, which we never set). Folding the deltas per browser in `localStorage`
made devices disagree about the same conversation. `bff/src/session/turn-usage.ts` folds every
scope's steps (skipping `subagent_id` deltas, which share the parent's scope) and serves the
last finished turn plus the one in flight at `GET /api/turn-usage`; the web refetches on each
usage delta and `turn_finished`, and it observes frames **before** the fan-out so that refetch
always finds the step. Note the split pi-ai makes: `prompt_tokens` is **net of the prompt
cache**, which comes as `cached_input_tokens` (llama.cpp's slot cache) — an 85k context behind
a 790-token prompt is a cache hit, not a bug.

**A turn push waits for the agent to be done, not for `turn_finished`.** One request often
spans several turns and `turn_finished` fires for each. `bff/src/push/turn-watcher.ts` holds a
finished turn until the scope has had nothing processing (`update_device_status`), nothing
queued that will run (`update_queue`, paused items excluded) and no pending/running subagent
(`update_subagent_state`) for `SETTLE_MS` (5 s), then pushes the **last** turn's outcome,
capped at `MAX_HOLD_MS` (30 min) so a stuck subagent cannot swallow it. Whether a session is
watching is decided when the push is due. Titles name the agent (`agent_retrieve` via the
permanent connection, cached 10 min in `push/agent-names.ts`, "Letta" if the lookup fails).

**An expired login must not look like "offline".** A refused WebSocket upgrade reaches the
browser as close code 1006 with no HTTP status, identical to a dropped network. Two rules:
- `/ws` resolves the session exactly like HTTP (`bff/src/auth/resolve-session.ts`: cookie, else
  the Access JWT, minting a cookie onto the 101). A signed-out upgrade is **accepted and closed
  with 4401** after a `__bff_auth_required` frame — never refused — because a close code is the
  one signal the browser can read.
- An expired **Cloudflare Access** login is blocked at the edge before the BFF sees it. After
  two consecutive failed opens `SessionClient` probes `/api/status` with `redirect: "manual"`
  (`web/src/lib/auth-probe.ts`): an `opaqueredirect`, 401/403 or `authenticated: false` means
  signed out → link state `signed-out`, and `use-session.ts` reloads the page once (top-level
  navigation is the only way through Access's login), at most every 5 minutes; after that the
  pill is a "Sign in again" button. A network error keeps the ordinary backoff.

The same permanent connection is also what boots the cron scheduler and Telegram adapters:
app-server process services start on *first client attach* (`listener/lifecycle.ts` →
`startConnectedListenerRuntime`), so with no client ever connected, crons never fire.

### All durable state lives under one host root

`LETTA_STATE_DIR` (`docker/compose.yml`) anchors every bind mount:

```
$LETTA_STATE_DIR/
  letta-home/     -> /root/.letta   settings.json, mcp-home/ (shared MCP list), global skills
  letta-data/     -> /data          conversations + agent memory (memfs git repos)
  workspaces/     -> /work          agent working directories
```

It defaults to `../..` relative to the compose file; prod sets an absolute path. **The default
is a trap in a worktree** — `../..` from `lettuce-worktrees/<feature>/docker/` resolves to the
worktrees directory, not the real state. Set `LETTA_STATE_DIR` absolutely in `docker/.env` so a
compose command run from anywhere hits the same state, and always do container work from the
main checkout.

Three named volumes remain, none precious: `bff-data` (web-push device endpoints, rebuildable by
re-subscribing), `google-policy` and `google-creds` (Settings → Google and its token — named
deliberately, so the app-server cannot mount them by accident through the state tree; losing
them only means reconnecting Google). Everything precious is in that one host directory, so a
backup is a single `tar`. `scripts/migrate-volumes-to-host.sh` moves an older install off the
named volumes; it copies and verifies but never deletes, because the memfs git history is the
only record of what an agent has learned.

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
namespace can reach the app-server at all — stronger isolation than a shared token on a bridge
network, and it removes the capability token entirely.

**Never recreate `app-server` on its own.** Its network namespace is the one the other two
services live in, so `docker compose up -d app-server` recreates it and leaves `bff` and
`channel-gateway` `Exited (1)` — the whole UI goes down, and `docker ps` without `-a` shows a
healthy app-server and no sign of why. Always run `docker compose -f docker/compose.yml up -d`
unscoped; it restarts the dependents in the right order. (Rebuilding only `bff` is still fine —
nothing shares *its* namespace.)

**Channel configuration is not reachable from the web UI, by design of letta-code.** The
app-server only dispatches `channel_*` commands when `runtime.serviceCommandHandler` is set
(`message-router.ts`), installed by `startChannelGatewaySupervisor` — which has no production
caller and talks to its child gateway over **stdio**, not the WebSocket. A `channel_*` command
sent over the app-server socket is parsed, matched by nothing, and silently dropped. They are
therefore excluded from the BFF's browser allowlist: a hang is worse than a refusal.

**The gateway is opt-in: `channel-gateway` has `profiles: ["telegram"]`** (off since
2026-09-28 — no channel was in use, and it idled at ~170 MiB). It runs only when
`COMPOSE_PROFILES` includes `telegram` (e.g. `cloudflared,telegram`; `LETTA_MODE` matches
`cloudflared` with `includes`, so extra profiles are safe). Removing the profile does **not**
remove a running gateway — `up -d` merely stops managing it — so it must be stopped with
`--profile telegram rm -sf channel-gateway`, and on prod that is a host-side step, since the
dockhand skill cannot stop containers. With no gateway, agents simply have no `MessageChannel`
tool.

**The sidecars are opt-in too: `google-mcp` has `profiles: ["google"]`, `searxng` and
`ddg-mcp` share `profiles: ["search"]`.** Prod runs
`COMPOSE_PROFILES=cloudflared,google,search,codex,claude`. Nothing `depends_on` them; without
their token the integration is off wholesale — the BFF treats the stored Settings switch as
disabled whatever it says (no sidecar config on, no shared-MCP-list entry, no native tools),
so dropping the profile is the whole off switch. Same removal rule as the gateway:
`--profile <p> rm -sf …`.

**`COMPOSE_PROFILES` is the one feature list, and it carries two VIRTUAL profiles: `codex` and
`claude`** — tokens no service declares, so they start no container. Every token is matched as an
exact comma-delimited entry (`bff/src/config.ts` `hasProfile`: `searchy` ≠ `search`), and the BFF
derives `config.features` = `web`⇐`search`, `google`⇐`google`, `codex`⇐`codex`, `claude`⇐`claude`.
- **effective-enabled = token AND stored Settings switch**, enforced at each availability
  decision: web tools render disabled (`renderAllMods`), Google reapply/status/sidecar-config
  run on the gated settings, and the codex/claude connect-time reapply writes `enabled: false`
  into `letta-ui.json` so the shims refuse — the stored endpoint/model/key survive, so
  re-enabling the token needs only one flip of the switch. The four Settings save routes answer
  404 while their token is off; `web/` hides the matching Settings sections, Tasks run lists
  and Agent → Tools rows from `features` in `/api/status` (absent = all on).
- **The coding tokens also decide the app-server image**: the raw string goes in as the build
  arg `CODING_FEATURES`, the Dockerfile installs a CLI only for a token it finds, and writes
  what it actually installed to `/opt/letta-ui/features`. **The image tag does not change with
  the token list** (it names version pins), so toggling a coding token REQUIRES an app-server
  rebuild, and on the one tag you can have an image built either way — the BFF reads the marker
  on every connect, logs a loud mismatch when a token is on but the CLI is not baked in (and
  "predates the marker" when the file is absent), and serves it as `coding_installed` in the
  authenticated `/api/status`. A warning about unknown profiles from Compose is fine: profile
  names are free-form and `docker compose config` accepts tokens no service declares.

Telegram is set up once with the CLI inside the gateway container (see `docker/README.md`),
the same way llama.cpp is set up with `letta connect`. The gateway then runs it, and the agent
reaches it through the `MessageChannel` tool the gateway registers as an external tool.

### Other load-bearing facts about the app-server

- **Browsers cannot reach the app-server directly.** Auth is `Authorization: Bearer` only,
  which browsers cannot set on a WebSocket; and unauthenticated upgrades carrying `Origin` are
  rejected outright. The BFF is mandatory, not a convenience.
- **No per-user isolation.** One process-wide runtime; every socket sees every event. v1 is
  single-user by decision. Keep agent-id filtering in the BFF frame router so multi-user stays
  a small change. This is about isolation, not about how many people may sign in:
  **`ALLOWED_USERS` therefore stays a list** — in cloudflared mode it is a defense-in-depth
  mirror of the Cloudflare Access policy, and what still stands if that policy is misconfigured
  (a bypass rule, "everyone in the directory"). Do not collapse it to a single address.
- **The allowlist is env-only, and local mode infers it.** `ALLOWED_USERS` is a comma-separated
  list, required exactly when Access is the live gate (`mode === "cloudflared" && !devBypassEmail`
  — the same condition that requires `CF_ACCESS_*`). In local mode an unset `ALLOWED_USERS`
  makes `DEV_BYPASS_EMAIL` its own entry; an explicit `ALLOWED_USERS` still wins and
  `/auth/dev-login` refuses with a 403 on a mismatch. Story (no `users.json`, the `EISDIR`
  crash-loop, `AllowedUser.name`): docs/upstream-notes.md#allowlist-env-only-story.
- **MCP is one shared list, kept out of upstream's `settings.json`, and agents learn it from a
  skill.** Upstream MCP is per-agent only (`settings.json` → `agents[].mcpServers`), and in
  app-server mode it is not native tools: agents run `letta mcp search|tools|schema|call`
  through Bash, a fresh process that reads settings and connects per call. Writing the
  per-agent entry **does not stick** — the app-server rewrites the whole `agents` array from
  its in-memory copy on any agent-setting change (`upsertAgentSettings` → `markDirty("agents")`
  → `persistSettings`), and `reload` never re-reads the file. Full story:
  docs/upstream-notes.md#mcp-shared-list-story.
  - So `bff/src/mcp/` keeps the list in `/root/.letta/mcp-home/.letta/settings.json`, a file
    the app-server never loads, under the synthetic agent `agent-local-mcp-global`. The
    `mcp-servers` skill's wrapper runs `HOME=/root/.letta/mcp-home letta mcp "$@" --agent
    agent-local-mcp-global`, which is what makes the list global. The file sets
    `autoConversationTitlesRollbackApplied: true` — load-bearing: without it
    `settingsManager.initialize()` persists on every CLI call and races our writes. The skill
    (SKILL.md with the server names in its description, plus the wrapper) is rendered into
    `mcp-home/skill/` and linked with `skill_enable` (the protocol cannot delete files, so an
    empty list is `skill_disable`), on every save and every upstream connect. No reload is
    needed: skills and the file are read from disk per turn and per call. Both traps (the
    "MCP servers with available tools: None" reminder and plain `letta mcp list` returning `[]`)
    are named in the skill's description, not just its body. A fresh install's list starts
    empty; nothing is seeded. Codex's `mcp: {inherit: true}` forwards that same empty list, so
    the Tasks form no longer offers it and `delegating-to-codex` tells agents to hand workers
    the wrapper instead.
  - **Most turns reach these servers through native tools, not the skill: the MCP bridge**
    (`bff/src/mcp-bridge/`, the `letta-ui-mcp-bridge.mjs` mod). Four tools with small static
    schemas — `mcp_search` (keyword-ranked, marks each hit read-only or writes), `mcp_describe`,
    `mcp_call` (auto; **refuses** any tool the server does not mark `readOnlyHint` — unmarked
    counts as a write) and `mcp_call_write` (`approval: "ask"`). Search-then-call rather than
    one native tool per MCP tool keeps the per-turn prefill constant. The BFF is the MCP client
    (SDK, one session per call) for **http and sse servers only** — a stdio server's command is
    written for the app-server container, so it stays on the skill wrapper, as do subagents
    (no mod tools). `McpCatalog` caches `tools/list` per server (connect, MCP save, Google
    change, 10-min TTL); names are upstream's `mcp__<server>__<tool>`. The skill's description
    now says so. Browsers reach none of these files: `/api/mcp` reads and writes the list (an
    entry is a command line agent shells exec), and `settings.json` is no longer a readable
    exception.
- **letta-code's filesystem sandbox is OFF, deliberately, and the image carries no bubblewrap.**
  The app-server runs upstream's `letta/letta:<version>` (plus the Codex CLI, nothing of
  upstream's changed) with Docker's default seccomp, AppArmor and capabilities, and
  `LETTA_FS_SANDBOX: "0"`. The explicit `"0"` is load-bearing: unset is not off — memory
  subagents are sandboxed by default whenever a bwrap backend exists
  (`src/sandbox/availability.ts` `isFsSandboxEnabled`). What remains agent-to-agent is
  letta-code's in-process `evaluateCrossAgentGuard` (`permissions/cross-agent-guard.ts`),
  which covers the file tools (Read/Edit/Write) and does not depend on the flag; shells are
  unconfined within the container. Real agent-to-agent isolation would mean one app-server
  container per agent — not re-enabling the flag. The 2026-09-25 measurement that justified
  removal (`CAP_SYS_ADMIN`, `buildBwrapArgs`, unmasked conversations, the `cap_add`/
  `seccomp:unconfined`/`apparmor:unconfined` price):
  docs/upstream-notes.md#bwrap-sandbox-removal-measured-2026-09-25.
- **Skills have four scopes, and none of them is per-conversation.** Discovery
  (`src/agent/skills.ts`, `src/agent/client-skills.ts`) reads, lowest priority first: bundled
  (in the package), global `/root/.letta/skills/`, agent `~/.letta/agents/<id>/memory/skills/`,
  project `<cwd>/.agents/skills/` with `<cwd>/.skills/` as a legacy fallback. Our cwd is
  `/work/<agent-id>`, so **project scope is effectively per-agent**. Symlinks are followed
  deliberately (`findSkillFiles` stats symlinked entries, with a realpath loop guard), so
  linking a skill in from a git checkout works and stays current.
  - **`skill_enable` always means global.** It validates `<skill_path>/SKILL.md` and symlinks
    the directory into `/root/.letta/skills` (`listener/commands/skills-agents.ts`).
    `skill_disable` only unlinks from there, so on a project- or agent-scoped skill it answers
    "Skill not found", and it **refuses a real directory** ("not a symlink") — so Settings →
    Global skills offers Disable only on a global skill whose root entry is a link (`link` in
    `/api/skills`), and not on the ones the BFF reinstalls itself (`managedBy`: the shipped
    skills and `mcp-servers`).
  - **An agent can install into any scope.** Shells are unconfined within the container (the
    sandbox is off), so an agent's shell can write `/root/.letta/skills` (global) and its own
    agent memory dir, and `skill_enable` from a shell works.
  - **Upstream publishes the list only during a turn, so the BFF discovers it itself.**
    `device_status.current_available_skills` is set in `turn-setup.ts` on the *conversation
    runtime*, which is evicted between turns (`evictConversationRuntimeIfIdle`), after which
    `buildDeviceStatus` sends `[]`. No protocol command lists skills. `bff/src/skills/`
    re-implements discovery (roots, override order, the frontmatter parser,
    `disable-model-invocation`, the bundled skills hidden from local agents; memfs `skills/`
    counts as `agent`) and serves `GET /api/skills?agent_id=&cwd=`. Bundled skills live only in
    the app-server image and are read over the upstream connection (cached per connect); every
    other root comes from the BFF's **read-only mounts** of `letta-home` and
    `letta-data/local-backend/memfs` at the app-server's own paths — not the protocol, because
    `list_in_directory`/`get_tree` skip symlinks and every `skill_enable`d skill is one.
    `sync-upstream.sh` flags the upstream files this mirrors. Both views (Agent → Skills;
    Settings → Global skills) re-read on every `skills_updated` frame.
  - **`skillsDirectory` is not reachable.** It exists on `runtime-context.ts` but has no
    `runtime_start` field and no settings key, so a repo shipping its skills under its own
    convention (`.letta/skills`, `.claude/skills`) has to be symlinked into a scanned path.
  - **Upstream quirk:** `permissions/analyzer.ts` `projectRegex` matches only
    `<cwd>/.skills/<name>/scripts/`, not the canonical `.agents/skills/`. A project skill with a
    `scripts/` directory earns scoped skill-script permission rules at the *legacy* path only.
  - `runtime_start` sending neither `skill_sources` nor `preserve_skill_sources` clears
    `scopedRuntime.skillSources`, which is harmless: `getSkillSources()` then falls back to
    `ALL_SKILL_SOURCES`. Do not "fix" it into an empty list.
- **The LLM timeout bounds prefill, not generation — and there is no idle timeout.** A
  streaming fetch resolves on headers, so the clock covers connect + queueing + prompt eval
  and stops the moment tokens start; a long generation is never cut off and a stalled stream is
  never rescued. `docker/compose.yml` raises the 5-minute default to 30 for the app-server.
  Env names, most specific first: `LETTA_CODE_OPENAI_COMPATIBLE_TIMEOUT_MS`,
  `OPENAI_COMPATIBLE_TIMEOUT_MS`, `LETTA_CODE_LOCAL_PROVIDER_TIMEOUT_MS`; a stored `timeout` on
  the provider record outranks all of them; values parse as ms, `600s`, `10m`, or `false` to
  disable — **an unparseable value throws**. A timeout **is** retryable (`"timed out"` in
  `RETRYABLE_LOCAL_PROVIDER_DETAIL_PATTERNS`); a GPU fault like
  `vk::Queue::submit: ErrorDeviceLost` classifies as `local_backend_error` and ends the turn.
  `createLocalProviderFetch` is dead code — do not "fix" a timeout by editing it. Changing this
  env means recreating `app-server`, which drops the BFF's permanent upstream connection.
  Internals walkthrough (`DEFAULT_LOCAL_PROVIDER_TIMEOUT_MS`, `fetchWithTimeout`, the dead
  `createLocalProviderFetch`): docs/upstream-notes.md#llm-timeout-internals.
- **Two different things are called "the system prompt", and an agent can only change one.**
  `agent.system` — what Agent → General shows — is a letta-code-**managed** preset, tracked in
  `settings.json` as `systemPromptPreset` + `systemPromptHash` + `systemPromptVersion`;
  `scheduleManagedSystemPromptUpdate` (`agent/system-prompt-versioning.ts`) overwrites `system`
  with the new preset text on a version bump while the hash still matches. Editing it flips the
  agent to `systemPromptPreset: "custom"` and opts it out of every future refresh. No agent
  tool writes this field. What an agent rewrites when asked to change its own instructions is
  `memory/system/persona.md` in its memfs (0.33.3+ agents get the flat "root MemFS" layout
  instead: `persona.md` at the repo root plus a `MEMORY.md` index, detected by that index)
  (`/data/local-backend/memfs/<agent-id>/memory/`, a git repo — `git log` there is the
  provenance). That block is composed into context every turn when `memfs: true`, and the UI
  surfaces it in the **Memory** tab, not Agent → General. Expect "I asked it to update its
  system prompt and the UI shows the old one" — both statements are true and about different
  fields.
- **Memory lives outside every agent workspace, and agents write it with ordinary file tools.**
  The memfs repo is `/data/local-backend/memfs/<agent-id>/memory` (`$MEMORY_DIR` in the agent's
  shell env) — never under `/work/<agent-id>`. Since letta-code 0.33 the in-process `memory`
  tool (and `memory_apply_patch`) is in **no toolset** (`tools/toolset-catalog.ts`); its code
  still exists but no agent can call it. Agents use plain `Edit`/`Write`/`Bash` on
  `$MEMORY_DIR` (the file tools pass the cross-agent guard for the agent's own memory; shells
  are unconfined), and the repo's `pre-commit`/`post-commit` hooks validate frontmatter.
  Incidental upkeep and post-turn git conflict repair go to a background memory worker (a
  registered subagent — internals: docs/upstream-notes.md#memory-worker-internals).
  `letta memory` (the CLI) has status/diff/backup/export/pull but **no write verb** — its own
  help says "use git commands" — so an agent that goes looking there finds nothing and
  concludes memory is unwritable.
- **Stop cannot actually cancel a local generation, and the app-server says it did.** The abort
  controller is wired to nothing, so the turn can only end when the model's **next chunk**
  arrives; press Stop during prefill and llama.cpp finishes the whole response. The UI **must**
  use `request()` and not `send()` for abort: a second press returns no frames at all and a
  stale runtime answers `success: false, error: "Runtime is no longer active"`, both visible
  only in `abort_message_response`; `use-conversation.ts` does, and renders its own honest
  "Stopping" line for the gap. Fixing the cancellation itself needs an upstream change; it
  cannot be done from here. Full call chain:
  docs/upstream-notes.md#stop-cancellation-call-chain.
- **`tool_return_message` has two shapes, and one call emits several frames.** A live delta
  carries the singular `tool_call_id`/`status`/`tool_return` fields **and** a `tool_returns[]`
  array; history persists only the singular ones. `tool_returns` is absent from
  `protocol_v2.ts`, so **typecheck cannot catch drift here** — a behavioural item, like
  `connection-lifecycle.ts`. One call can emit a running snapshot frame and a canonical one
  with different ids and no `otid`, so `web/src/lib/messages.ts` keys returns
  `return:<tool_call_id>` in both paths; the later frame carries the **corrected** status (the
  running snapshot reports `success` even for a command that goes on to fail, and the store
  persists the snapshot's status — upstream, not ours). Capture detail:
  docs/upstream-notes.md#tool-return-message-capture-detail.
- **Every tool call arrives as `approval_request_message`**, approved or not. The real approval
  prompt is the `control_request` frame that drives `ApprovalSheet`; the message is just the
  call record, so the transcript labels it "Tool".
- **Every model text part is an `assistant_message`, even `"\n"`.** Local models emit text
  between tool calls — narration and, for some, a lone newline per step (`[thinking, toolCall,
  "\n", toolCall]` in the pi-ai store). `groupTranscript`
  (`web/src/lib/messages.ts`) drops blank text, treats text that more work follows **within
  the same turn** as narration (turn boundaries: your message, a task notification, an injected
  reminder, a notice) and folds a turn's work into one run headed by its latest narration line;
  only the turn's last text is an answer. Live, the newest text is an answer until a step
  follows it.
- **Provider errors reach the transcript as JSON.** `local-provider-errors.ts`
  `localProviderErrorDetail` joins the error message with `JSON.stringify()` of whichever of
  `responseBody`, `data`, `body`, `detail`, `code` the failure had, and the terminal `loop_error`
  carries that detail. `splitErrorDetail` in `web/src/lib/messages.ts` lifts the payload's own
  `message` for the headline and keeps the body behind a disclosure.
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
  streamed); anything from the repo must travel in an image. `AGENT_APP_PORTS` and
  `AGENT_APP_HOST` (the address to put in URLs, from `docker/.env`) are in the app-server env
  for it. No auth in front of those ports, and the processes die with the container. The
  skill's frontmatter `name` must match its directory.
- **Codex workers: letta-code runs them, a shim makes them fit this container.** Since 0.33,
  `Task` / `launch_subagent` accept `subagent_type: "codex"` and spawn `codex app-server
  --stdio` from PATH (`tools/impl/external-coding-agent.ts`, `codex-app-server.ts`). Our
  app-server image (`docker/codex/Dockerfile`) installs the real CLI under `/opt/codex` only
  when the `codex` profile token is in `CODING_FEATURES` (see "COMPOSE_PROFILES is the one
  feature list"), and always puts `docker/codex/codex-shim.mjs` on PATH as `codex` — with the
  CLI absent the shim's preflight fails with ENOENT and the task reports it. Upstream
  unmodified.
  - The shim's one rewrite: letta hard-codes `sandboxPolicy: workspaceWrite` on every
    `turn/start`, Codex builds that with bubblewrap, and Docker's default seccomp/AppArmor
    refuse it — so the shim rewrites that field to `{type: "externalSandbox"}` and passes
    every other byte through. A worker therefore has the same reach as an agent shell (the
    whole container, other agents' memory included) and Codex enforces nothing, network
    included — the UI offers no network toggle. Spike detail (`use_legacy_landlock`,
    `requirements.toml` `allowed_sandbox_modes`, the placeholder `auth.json`):
    docs/upstream-notes.md#codex-spike-findings-2026-09-27-codex-01571-measured-in-the-container.
  - **The preflight is `codex --version`** (since 0.33.3). With workers disabled the shim fails
    it, so the task reports "Codex executable is not ready: <our disabled message>".
  - **Configuration is Settings → Codex workers, owned by the BFF** (`bff/src/codex/`). It
    stores `letta-ui.json` in `CODEX_HOME=/root/.letta/codex` (persisted, so threads survive
    recreates and `SendAgentMessage` follow-ups can resume them) and renders `config.toml`
    (provider `letta-ui`, `wire_api = "responses"` — the endpoint must serve `/v1/responses`,
    which llama.cpp does) and `auth.json` from it, on every save and every upstream connect.
    The API key never goes back to a browser. `letta-ui.json` is also the switch: the shim
    refuses to run until it says `enabled`, and that refusal is what a task reports. With the
    `codex` token off the connect-time reapply writes `enabled: false` regardless of the stored
    switch and the settings save route 404s — the endpoint and key survive, only the switch
    resets.
  - **letta keeps only a worker's final message.** The full run lives in Codex's rollout,
    `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`, appended live. Thread
    ids are UUIDv7, so the day directory comes from the id. `GET /api/codex/runs[/:threadId]`
    parse it (`codex/rollout.ts`); the viewer polls while a run is going. The task notification
    carries `agent_id=codex_<thread id>` (success only), which is how a transcript entry links
    to its run. The live `update_subagent_state` snapshot does **not** carry it (`agent_url`
    stays null for external workers), hence the "Codex runs" list in Tasks.
  - **cwd is whatever the parent runtime's is:** `/work/<agent-id>` for UI conversations, but
    `/work` for a runtime started without a cwd (cron- and channel-fired ones).
  - Upstream drift to watch: the shim depends on letta's `turn/start` shape and the preflight
    command; re-verify both on every letta-code or Codex bump (`CODEX_VERSION` is pinned in
    compose, never floated).
- **Claude Code workers: the same arrangement, minus the sandbox rewrite.** Since 0.33 upstream
  also accepts `subagent_type: "claude-code"` and spawns `claude --print --input-format
  stream-json --output-format stream-json …` with the prompt on stdin
  (`tools/impl/claude-stream-session.ts`). The image installs the real CLI under
  `/opt/claude-code` only when the `claude` profile token is in `CODING_FEATURES` (like Codex
  above) and always puts `docker/codex/claude-shim.mjs` on PATH as `claude`; the shim rewrites
  nothing (argv and stdin pass through verbatim) — its whole job is env injection and the
  switch.
  - **Claude Code speaks only the Anthropic Messages API**, which llama.cpp does not serve:
    Settings → Claude Code takes a user-supplied Anthropic-compatible base URL (a LiteLLM-style
    proxy or any Anthropic-API gateway), a model id, and an optional auth token. There is no
    config file to render — the shim injects `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` and
    `ANTHROPIC_AUTH_TOKEN` from `letta-ui.json` in `CLAUDE_CONFIG_DIR=/root/.letta/claude`
    (on the letta-home mount), each only if not already in the env.
  - **The preflight is `claude auth status --json`** and needs `{"loggedIn": true}` on stdout
    with exit 0 — measured on 2.1.285, any `ANTHROPIC_AUTH_TOKEN` value satisfies it, so the
    shim injects a placeholder when none was configured (a proxy that checks the token fails
    honestly at request time). Disabled workers: the shim refuses every call with our message,
    which the task reports as "claude-code authentication is not ready: …".
  - **Runs live in Claude's own transcripts**, `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/
    <session-id>.jsonl` (slug = absolute cwd, non-alphanumerics → `-`), appended live. Session
    ids are plain UUIDv4 — not Codex's UUIDv7 — and the listing has no mtimes, so recency comes
    from each file's newest entry timestamp and "running" is a 5-minute-since-last-entry
    heuristic. `GET /api/claude/runs[/:sessionId]` parse it leniently (`claude/transcript.ts`;
    the format is internal to Claude Code and may change between versions). The task
    notification carries `agent_id=claude_<session id>`.
  - Pin site: `CLAUDE_CODE_VERSION` in compose (build arg + image tag), like `CODEX_VERSION` —
    separate from `LETTA_CODE_VERSION` and not checked by `check-version-pin`. The shim depends
    on the preflight shape and the stream-json flags; re-verify on every bump.
- **"Subagent process exited with code unknown before returning a result" = the spawn failed.**
  Subagents are child `letta` processes (`executeSubagent`); on Node a null exit code *and*
  signal comes only from the child's `error` event, and `spawnSubagentProcess` discards that
  error, so stderr is empty and no errno survives. Two things of ours around it:
  - `init: true` on `app-server`, so PID 1 reaps orphans. Without it, backgrounded processes
    stay zombies against the cgroup's `pids.max` until a recreate — near the cap, spawns fail
    with `EAGAIN`. Diagnosis story: docs/upstream-notes.md#zombie-eagain-diagnosis-2026-09-29.
  - `docker/codex/spawn-diagnostics.cjs`, preloaded into every node process in the image
    (`ENV NODE_OPTIONS=--require …` in the Dockerfile, never compose: a missing `--require`
    target kills every node process). It logs `[letta-ui spawn-diag] spawn failed: <errno>
    file=… cwd=… pids=<current>/<max> zombies=<n>` to stderr, i.e. `docker logs` for the server
    and the "stderr tail" of a failing child's parent. Observe-only: it wraps
    `ChildProcess.prototype.emit` and never adds an `error` listener.
- **Provider connection state is `connected.is_connected`**, not `connected.connected`.
- **Settings are split by scope, and the split is the UI's only statement of it.** The **Agent**
  tab (`web/src/tabs/AgentTab.tsx`) holds what belongs to the selected agent: General (name,
  model, base system prompt, delete), Tools, Secrets, Reflection, and the Skills it sees.
  **Settings**, the top bar's gear (`components/GlobalSettings.tsx`, full screen; wrapping
  chips with short names on a phone, the grouped list beside the section on desktop), holds
  what every agent shares — providers, web search, MCP servers, Google, Codex workers, global
  skills — plus this device's notifications and an About. A new setting goes where its backend
  key is: keyed by `agent_id` → Agent tab; a BFF file or an app-server-wide command → Settings;
  `runtime` scope → next to the conversation (composer).
- **Per-agent tool access (Agent → Tools) narrows Codex, Claude Code and Google through the
  mods, with no upstream change.** Settings → Codex workers, → Claude Code workers and → Google
  decide what exists; each agent can be cut down from there (Google full / read-only / off,
  Codex and Claude Code allowed / blocked). The BFF
  keeps it in `agent-tool-access.json` on `bff-data` (`bff/src/agents/tool-access.ts`, only
  non-default entries), and a save re-renders the mods and sends one `reload`. Three upstream
  hooks carry it (0.33.3):
  - **Hiding a tool:** `letta.tools.register({ isEnabled(ctx) })` is called per turn with the
    listener's mod context, whose `ctx.agent.id` is the agent (`filterAvailableModToolsRegistry`).
    `renderToolsMod`'s `hidden` map bakes agent → tool names in. A hidden tool is left out of
    that turn's schemas.
  - **Denying a call:** `letta.permissions.register({ check(event) })` sees `event.agentId` and
    `event.args`. Its `deny` replaces the built-in decision in `checkPermissionWithHooks`, in
    **every** permission mode, Unrestricted included. A Codex worker is not a tool of its own;
    it is `subagent_type: "codex"` on Task/Agent, plus `SendAgentMessage` to `codex_<uuid>` for
    follow-ups (same shape for Claude Code with `"claude-code"` and `claude_<uuid>`). So
    `letta-ui-agent-policy.mjs` (`bff/src/codex/policy-mod.ts`) matches on the
    arguments, not the tool name.
  - **Knowing the caller:** every mod call sends `x-letta-agent-id` from `ctx.agent.id`
    (`internal-tools/mod.ts`), and handlers get it as `ToolCallContext`. The MCP bridge filters
    its catalog per agent (`toolsForAgent`: off drops the Google server, read-only its writes),
    and the curated Google handlers re-check in case a mod is stale. A call with no header gets
    the default.

  This is availability, not isolation. Agent shells are unconfined, so a blocked agent can
  still reach `google-mcp:8000`, the `mcp-servers` skill wrapper, or `codex` / `claude` on PATH.
  The skill
  wrapper is also global and cannot be narrowed per agent. Entries of deleted agents are not
  pruned, like pins; they are harmless.
- **Web search and page reading are native tools, `web_search` and `fetch_webpage`, installed
  as a letta-code mod.** Upstream's own tools of those names are Letta-*server* tools, which our
  local backend (`serverSideToolManagement: false`) cannot have. A **mod** is upstream's
  supported way to add a client tool: a file in the app-server's global mods directory
  `/root/.letta/mods/` whose default export calls `letta.tools.register(...)`
  (`src/mods/mod-sources.ts`, `mod-engine.ts`). Listener turns get mod tools whatever the
  toolset preference (`tools/manager.ts` `capturePreparedToolExecutionContext`) — chats, crons
  and channel turns alike. **Subagents do not** (they run a providers-only capability profile),
  nor do Codex workers.
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
  - **Search:** the `searxng` sidecar (`docker/searxng`, pinned `SEARXNG_VERSION`, settings
    baked into the image *outside* `/etc/searxng` — that path is a declared VOLUME and compose
    carries an anonymous volume across recreates, so a settings change there would never land).
    Engines probed from a residential IP: bing, brave and yahoo answer; duckduckgo and qwant
    return CAPTCHA; mojeek is inactive upstream (proof-of-work CAPTCHA); google needs
    JavaScript. When SearXNG is down or every engine failed, the BFF falls back to ddg-mcp's
    `search`, whose browser-TLS fallback SearXNG's duckduckgo engine lacks.
  - **Pages:** ddg-mcp's `fetch_content` in markdown mode (`web-tools/ddg.ts`, MCP SDK, one
    session per call). The sidecar keeps the rate limiter (30 searches / 20 fetches a minute)
    and page cache, and fetches from its own container, not the BFF's.
    `DDG_REF_URL_THRESHOLD: "0"` so fallback results carry real URLs, not `ref://` tokens. The
    Host header must stay `ddg-mcp:8000` (its `--allowed-hosts` DNS-rebinding guard).
  - **Loading: no file watch.** Global mods load on the first client connection (the BFF's,
    `app-server.ts` `getStartupReady`) and again only on `execute_command reload`, which needs
    an agent runtime (`listener/commands.ts`). So `resyncMods` (index.ts) renders all three
    mods, writes only those that differ (`internal-tools/install.ts` `syncMods`) and sends
    **one** `reload` in the first agent's `default` conversation — retried every 30 s while no
    agent exists. It runs on connect, on a Settings → Web search or → MCP servers save, and
    4/12/30 s after any Google change. An app-server restart needs no reload: the files are
    already there.
  - **Settings → Web search** (`/api/web-tools/*`, `/root/.letta/web-tools/letta-ui.json`): a
    switch (off renders a mod that registers nothing — the protocol cannot delete a file),
    backend status, a test search, and mod load errors from letta-code's
    `/root/.letta/mods/diagnostics/latest.json` (errors only — a clean load writes nothing).
    The `search` token gates it: with the token off the stored switch is treated as off when
    the mod is rendered and the settings save route 404s.
  - **duckduckgo left the shared MCP list** in a one-time migration (`retireSeededDdgMcp`,
    recorded as `mcpDdgRetired`), so a user who adds it back keeps it.
- **Google (Gmail / Calendar / Tasks / Contacts) is a sidecar whose access no agent can change.**
  Agents reach `http://google-mcp:8000/mcp` (`docker/google-mcp`:
  taylorwilsdon/google_workspace_mcp, pinned `WORKSPACE_MCP_VERSION`, under `supervisor.py`),
  listed in the shared MCP list while it serves. The `google` token gates all of it: with the
  token off, reapply and status run on effective settings (stored switch forced off, sidecar
  config and MCP-list entry out) while the stored client, switch and grant survive, and the
  settings save route 404s. Reaching it is not the control — agent shells
  reach everything. What it may do is fixed in two places no agent can touch:
  1. **The token's OAuth scopes.** The BFF runs the consent (`bff/src/google/`), asking for
     exactly the levels' scopes, never `include_granted_scopes`. Invariant: the token never
     holds a scope the policy does not want — narrowing a level **revokes** it, a consent that
     comes back wider is revoked unkept, and changing the OAuth client drops it. **A revoke is
     grant-wide** — it kills every refresh token this client issued, so a same-account
     reconnect must never revoke the old token first (it did, on prod 2026-09-28; story:
     docs/upstream-notes.md#google-revoke-on-reconnect-2026-09-28). Widening waits for a
     reconnect; meanwhile the sidecar runs at what the grant covers (`coveredPermissions`,
     which also handles scopes unticked on Google's consent screen).
  2. **workspace-mcp's `--permissions`**, which filters its tool list by the same scopes.
     `bff/src/google/policy.ts` mirrors its level → scope table (`auth/permissions.py`) —
     re-verify on every version bump. The supervisor also removes `start_google_auth` (else any
     agent can mint a consent link), sets `WORKSPACE_MCP_DISABLE_LOCAL_FILES=true`
     (**load-bearing**: without it tools accept server-side `file_path`, and an agent could
     mail itself `/creds`), and launches from a clean env so no `WORKSPACE_MCP_*` fallback
     widens it.

  Both live on the `google-policy` / `google-creds` volumes, mounted by `bff` and `google-mcp`
  **only — never mount them into `app-server` or `channel-gateway`.** The token file is
  workspace-mcp's own format (`<email>.json`, `LocalDirectoryCredentialStore`); single-user
  mode uses the first file it finds, so connecting clears the directory first. The supervisor
  polls `sidecar.json` and restarts on change; disabled means nothing listens.

  **Dev bypass is the hole.** Agent shells share the BFF's namespace, so in dev-bypass mode
  they can `curl 127.0.0.1:8080/auth/dev-login` and hold a session. Google writes are
  therefore refused whenever `DEV_BYPASS_EMAIL` is set (`googleWritesAllowed`) unless
  `GOOGLE_ALLOW_DEV_BYPASS=true`. Every **other** setting (MCP list, Codex, agents) is still
  writable that way in local mode — a known gap, not fixed here. Behind Cloudflare Access an
  agent cannot mint a session. The OAuth callback is gated by its single-use `state`, not the
  cookie, so a `GOOGLE_OAUTH_REDIRECT_URI` on another origin (localhost) works.

  Limits by design: the sidecar holds one policy for every agent (a per-agent *boundary* would
  need per-agent containers; Agent → Tools narrows who is *offered* what, see "Per-agent tool
  access"), and allowed tools still combine — Calendar `full` can invite any address, which
  mails them even with Gmail read-only, and email content is prompt-injection input.

  **A token Google stops accepting is kept, marked lost — never silently dropped.**
  `google/lost-access.ts` recognises Google's own refusals (`invalid_grant`,
  `Token Expired/Revoked`, no credentials) in the curated tools and in `mcp_call` on the
  Google server, records `grant.lostAt` (`markLost`), and answers the agent with reconnect
  links built on `PUBLIC_ORIGIN`: `/api/google/reconnect` (GET, session- and write-gated —
  mints a consent `state` and 302s to Google) and `/?settings=google`
  (`lib/settings-link.ts`). Settings → Google leads with "Access lost for …" and a Reconnect
  button; opening it re-checks with Google (`checkIfDue`, at most every 5 min), and a refresh
  that works again clears `lostAt`. The `accessNotConfigured` mis-mark incident and the full
  design: docs/upstream-notes.md#google-token-loss-story.
- **Agents use Google through native tools, not the skill** (`bff/src/google/tools.ts`, the
  `letta-ui-google-tools.mjs` mod): `gmail_search`, `gmail_read`, `calendar_events`,
  `calendar_freebusy`, `tasks_list`, `contacts_list`, `contacts_get` (reads, never ask) and
  `gmail_send`, `gmail_draft`, `calendar_event`, `tasks_update`, `contacts_update` (writes,
  `approval: "ask"`). Each is a compact schema mapped onto one workspace-mcp tool — its own
  schemas are large (`manage_event` has 32 parameters) and would ride in every turn's prefill.
  **Access control is unchanged:** a curated tool is registered only if the tool it maps to is
  in the sidecar's current `tools/list`, which `--permissions` and the granted scopes already
  filter, so read-only Gmail never shows `gmail_send`. `user_google_email` is left out:
  `--single-user` defaults it (and the bridge hides it from schemas). The mappings are pinned
  by a recorded `tools/list`
  (`bff/src/google/fixtures/workspace-mcp-<version>.{full,readonly}.json`, captured by running
  the pinned image with `--single-user --permissions …` and a dummy OAuth client — listing
  needs no token) and `google/tools.test.ts` checks every mapped tool, argument and read/write
  marking against it. **Refresh the fixture on every `WORKSPACE_MCP_VERSION` bump.**
  Everything else Google offers (labels, filters, focus time…) is reachable through the MCP
  bridge.
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
  subagents (and hidden agents leave `agent_list`), so it must not be borrowed. The BFF keeps
  two id lists (`bff/src/agents/id-list.ts`: `pinned-agents.json`, `archived-agents.json` on
  `bff-data`; `GET /api/agents/flags`, `PUT /api/agents/{pins,archived}/:id`; archiving also
  unpins). Archive only hides: crons, memory and conversations carry on. One `AgentMenu`
  (Edit, Pin, Archive, Delete) serves the phone switcher (opening above its ⋯) and every row of
  the desktop sidebar's agent list (opening below); it is fixed to the viewport because both
  agent lists scroll in boxes of their own, which clip an absolute menu, and closes itself on
  Back, Escape and presses elsewhere. `use-agents` returns `agents` pinned-first; both lists
  hide archived agents behind "Show archived agents (N)".
- **The desktop sidebar is two lists with one row language, told apart by where they sit.**
  There is no agent dropdown: agents are rows (`.agent-row`: round avatar, name, conversation
  count or a responding dot, ⋯) on a panel of their own (`.sidebar-agents`, `--surface-2`,
  capped at a third of the height); conversations stay on the sidebar's background with dates.
  Both mark the open row with a 3px left bar. Counts for other agents come from `useAgentStats`,
  fetched only at the desktop width (`useWide`) — the sidebar stays mounted, hidden, on a
  phone. ui-check reads the open agent from `.agent-row.active[data-agent-id]`.
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
     ever gains `--ws-auth`, the shared-network-namespace workaround can be dropped.
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

**Sync to a published release tag, never `main`:** the script accepts only `v<x.y.z>`.
Everything the stack runs comes from a **published artifact**: the images are
`letta/letta:$LETTA_CODE_VERSION` from Docker Hub, and the protocol types are
`@letta-ai/letta-code@<v>` from npm. A checkout sitting one commit past a tag has nothing to
pin to, and quietly stops being the code the app-server runs. `sync-upstream.sh` now asserts
both artifacts exist before re-pinning.

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
Compose's precedence order — that is how `.env` once sat a whole cycle behind unseen; story:
docs/upstream-notes.md#stale-pin-story. The pin check now prints a warning for exactly this
case.

**A version bump is a full redeploy.** `docker compose -f docker/compose.yml up -d --build` —
rebuilds the app-server image on the new base, pulls the new channel-gateway image and
rebuilds bff. This is the documented exception to "Only `bff` is rebuilt in step 4" under
Definition of done; that note governs ordinary UI and BFF changes, this one governs version
bumps. Recreating `app-server` drops the BFF's permanent upstream connection, so any in-flight
turn is lost and the cron scheduler and Telegram gateway restart on the BFF's reconnect.

## Git workflow

### Branches

Worktrees per feature, feature branches, fast-forward merge to `main`
(`git merge --ff-only`, no merge commits), no PRs. Rebase the feature branch onto `main`
first if it isn't already a fast-forward.

**The main checkout stays on `main` with a clean tree — only merges happen there.** All feature
work, including creating the branch and every commit on it, happens in a worktree
(`git worktree add ../lettuce-worktrees/<name> -b <branch>`). Branching inside the main
checkout lets two sessions collide and breaks `deploy-check`'s clean-tree and on-`main`
assertions — story: docs/upstream-notes.md#main-checkout-collision-story-2026-09-29.

Under Agent Manager, worktrees are created and removed by the manager, not by the agent.
An agent must never remove a worktree or delete a branch it did not create in its own session.
"Worktrees per feature" describes where work happens, not a cleanup duty.

**Every user-facing feature gets its own feature branch**: a new capability, a new service or
sidecar, or any change spanning more than one of `bff/`, `web/`, `docker/`. Small fixes and
docs may land directly on `main`; they simply carry a PATCH tag when they ship. (This is a
rule about the *scope* of a change; what bumps the version is "Versioning and tags".)

### Versioning and tags

The repo's own releases are **annotated tags on `main`**:

```
v<MAJOR>.<MINOR>.<PATCH>-letta_<LETTA_CODE_VERSION>     e.g. v0.1.0-letta_0.33.7
```

- Start at `v0.1.0-letta_0.33.7`; stay on `0.x` — MAJOR is reserved and effectively
  unused for a single-user app.
- **MINOR** (+1, PATCH resets to 0) = any new or changed user-facing functionality — a new
  feature, a changed workflow, a visible behavior change.
- **PATCH** (+1) = anything else that ships to prod on its own: fixes and hotfixes, a
  standalone `sync-upstream` bump, internal-only changes, a batch of small fixes.
- The `letta_<version>` suffix is read from the pin at tag time (`docker/compose.yml`,
  proven consistent by `check-version-pin`), never from memory. It never resets the
  semver part; a letta bump riding along with a feature just changes that tag's suffix.
- A tag is created **only after the prod deploy is verified** (Definition of done 7b)
  and pushed with `git push origin <tag>`. A failed deploy is never tagged.
- Before running it, make the release-time **docs sync** commit on `main` if the
  `[Unreleased]` range changed anything `README.md` or `docs/CONFIGURATION.md` describes
  (see "Docs sync"). `release.ts` only stages `VERSION` and `CHANGELOG.md`.
- **`bun run release --minor|--patch`** (`scripts/release.ts`) is the whole release as one
  gated command: it asserts `main` is clean and untagged, computes the next tag from
  `VERSION` + the compose pin, makes the release commit on `main`, runs `deploy-check`,
  prints the Dockhand plan, asks for the one confirmation (type the tag exactly; a
  non-interactive caller sets `RELEASE_CONFIRM=<tag>` after asking the human), then
  push → deploy → verify → upstream-log check → tag → push tag, stopping on any failure
  with no rollback. Doing it by hand is still allowed — this is the same order — but the
  hand version is what forgot the VERSION bump once.
- **`VERSION` at the repo root is the machine-readable record** — the full tag string,
  one line, bumped in the same commit that is tagged. The bff image `COPY`s it and the
  BFF serves it at `/api/status` (authenticated branch only — the route's
  no-fingerprinting rule stands), which is how Settings → About shows
  the "lettuce" row (About no longer shows a letta-code version row). The image cannot derive it: `.dockerignore` excludes
  `.git/` and the image carries no `git`, so `git describe` at build time is
  impossible. `deploy-check` asserts `VERSION` agrees with the tag pointing at `HEAD`.
- Tags and `VERSION` are the **only** version record. No `version` field in any
  `package.json` — it would be a seventh drift-prone pin site that nothing renders.
- Upstream's `v<x.y.z>` tags live in the **letta-code checkout**, a different repo —
  no collision with these, and `sync-upstream` is unaffected.
- `-letta_0.33.7` is not valid semver (underscore is not a legal prerelease character),
  and strict semver tools would sort such a tag below a bare `v0.1.0`. Deliberate — we
  never publish to a registry and never emit bare `v0.1.0`. Do not "fix" the format.

#### Changelog

`CHANGELOG.md` at the repo root keeps the user-facing entries, Keep a Changelog style adapted
to this repo's tag scheme:

- **Sections**: `Added` / `Changed` / `Fixed` / `Removed`. Omit empty sections. Newest release
  first; `[Unreleased]` always present at the top.
- **Entry voice**: one line, imperative ("Add…", "Fix…", "Remove…"), ≤ ~140 chars, phrased as
  what a user of the app notices — not the implementation. "Edit text files from the Files
  tab", not "wire `conversation_files_update` through the BFF".
- **Who writes them**: on the feature branch, in the same commit as the change (Definition of
  done step 2). Any change with user-visible behavior needs ≥1 entry; internal-only changes
  (refactors, CI, docs, test-only) need none.
- **On version bump**: the release commit that bumps `VERSION` renames `## [Unreleased]` to
  `## [v<new-tag>] - <YYYY-MM-DD>` (date of that commit) and starts a fresh empty
  `[Unreleased]` above it. This keeps `VERSION` and the changelog consistent by construction
  even if the deploy later fails and the tag is never created.
- **The release commit is made on `main`, never on a feature branch** — by
  `bun run release`, after every merge for that release and before the push. Parallel
  worktrees cannot know the next version: two MINOR features merged together are **one**
  MINOR release, and two branches each bumping `VERSION` would both claim the same tag.
  Between releases `main` sits at the last tag with entries accumulating under
  `[Unreleased]`, which `deploy-check` passes — nothing forces the bump early.
- **No links section** — private repo, no GitHub releases; do not add Keep-a-Changelog link
  references.
- `deploy-check` asserts `CHANGELOG.md` has `## [Unreleased]` and that its newest
  `## [v...]` section equals `VERSION`.

#### Docs sync (README and CONFIGURATION)

`README.md` (what the app is, architecture, how to run it) and `docs/CONFIGURATION.md`
(every environment variable and setting) describe the **shipped product**, so a release
must not be cut from a `main` whose docs describe the previous one.

- **Primary place — the feature branch, in the same commit as the change** (Definition of
  done step 2), exactly like the changelog entry: any change that adds or changes an env
  var, setting, port, sidecar, default, or user-facing workflow carries its `README.md`
  and/or `docs/CONFIGURATION.md` update with it. That is where the knowledge is fresh and
  where the diff is reviewed together with the code.
- **Release-time safety net — on `main`, right before `bun run release`**: skim the
  `CHANGELOG.md` `[Unreleased]` entries since the last tag and update anything the
  per-change commits missed, as a `docs:` commit on `main`. It must be its own commit
  because release requires a clean tree and `release.ts` stages only `VERSION` and
  `CHANGELOG.md`; being on `main` before the release commit, it rides into the tagged
  range and ships with the tag.
- A prose gate `deploy-check` cannot check: correctness of docs is a human/agent judgment
  at these two points, not an assertion.

## Definition of done

Work is **not done**, and must not be reported as done, until every line below passes. The
origin story (a change reported complete while the container still served the old bundle):
docs/upstream-notes.md#definition-of-done-origin-story.

Passing typecheck is not done. Passing tests are not done. **Running in the container is done.**

1. **`bun run verify` green** — lint, typecheck, tests, build. Fails fast; later stages
   do not run once one fails.
 2. **Committed** on a feature branch and fast-forwarded into `main`
   (`git merge --ff-only`). A user-visible change carries its `CHANGELOG.md` `[Unreleased]`
   entry — and its `README.md` / `docs/CONFIGURATION.md` update when it touched the
   configuration surface or a user-facing workflow — in the same commit. The **release commit** — the `VERSION` bump and the
   `[Unreleased]` rename — is never made on a feature branch: it is made on `main` at
   release time, after every merge for that release, by `bun run release` (see
   "Versioning and tags").
3. **Worktree lifecycle is owned by Kilo Code Agent Manager** — do not run
   `git worktree remove` or `git branch -d` yourself. Concurrent agents may have live
   worktrees; removing one that is not yours destroys another session's uncommitted work.
   `deploy-check` no longer requires a single worktree.
4. **Docker rebuilt from `main`** —
   `docker compose -f docker/compose.yml build bff && docker compose -f docker/compose.yml up -d bff`.
   The `build` is not optional; see the note below.
 5. **`bun run deploy-check` green** — asserts the tree is clean and on `main`, that the
    bundle the container serves is byte-identical to the one in `web/dist`, that `VERSION`
    agrees with the tag pointing at `HEAD`, that `CHANGELOG.md` has `[Unreleased]` and its
    newest release section equals `VERSION`, and that `/readyz` and the upstream app-server
    connection are healthy.
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
    first** (see "Stop before releasing to prod" for the full rule, target and order).
 7b. **Tagged** — once the prod deploy verifies, tag `main`'s HEAD with the tag `VERSION`
    names (`git tag -a "$(cat VERSION)" -m "<feature>"`) and `git push origin <tag>`.
    `VERSION` is bumped in the release commit itself (step 2), so the tag and the version
    the deployed UI reports are the same string by construction. Part of the same
    stop-and-ask confirmation as the release — never a separate approval, and never
    before `dockhand verify` is green.

### Stop before releasing to prod

**Never `git push` and never redeploy prod without asking, every time.** After merging to
`main` and passing steps 1–6, halt and ask for explicit confirmation of the full release.
Standing approval does not carry over: a yes on one change is not a yes on the next one, and
"go ahead" given before the preflight was shown is not a yes either.

Pushing is the one step that leaves this machine, and `origin` is the only copy of this
project that is not on one laptop — so it matters, and so it is worth a human deciding.
It comes last, after `deploy-check`, so nothing reaches `origin` that has not been proven
to run in the container first.

**Prod is deployed from `origin`, not from this machine.** Dockhand (http://192.168.1.24:3000)
builds the stack from `dmarchevsky/lettuce` `main` at the moment of the deploy (Dockhand's
stored stack URL must be updated when the repo is renamed), so the push
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
must show `Upstream connected: letta-code <pinned version>` → tag and push per step 7b.
A version other than the pin means
Dockhand's stored stack variables override it. On any failure, stop and report — no retry, no
rollback, no restart without the user choosing it.

`origin` is `dmarchevsky/lettuce` (renamed from `letta-code-ui`; update local remotes with
`git remote set-url origin`), private, and was empty until the first push. There
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
| `bun run verify` | **The gate.** worktree → version-pin → lint → typecheck → test → build, fail-fast |
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
| `bun run release --minor\|--patch` | The whole release: release commit on `main`, then gated push → deploy → verify → tag |
| `bun run check-version-pin` | Assert every letta-code version literal agrees (runs inside `verify`) |
| `bun run migrate-state` | One-shot: copy the old `letta-home`/`letta-data` named volumes onto the host |
| `docker compose -f docker/compose.yml build bff` | Rebuild the BFF image — **required** to ship UI changes |
| `docker compose -f docker/compose.yml up -d` | App-server + BFF; `cloudflared`, `google-mcp` (`google`), `searxng` + `ddg-mcp` (`search`) and `channel-gateway` (`telegram`) only with their profiles |
| `git push origin main` | Release, part 1 — **ask for confirmation first, every time** |
| `~/.claude/skills/dockhand-deploy/dockhand.sh plan letta letta-code-ui-prod` | Prod preflight: commits, compose diff, what gets recreated (read-only) |
| `… deploy letta letta-code-ui-prod --confirm` | Release, part 2 — prod redeploy via Dockhand, same confirmation as the push |
