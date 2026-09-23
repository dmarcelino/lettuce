# letta-code-ui — Project Guide

Self-hosted personal assistant: a local Letta agent (memory, crons, skills) driven from a
mobile-first web UI we own end to end. No Letta Cloud, no cloud LLM providers.

## Workspace layout

```
/home/dima/work/letta/
  letta-code/      fork of letta-ai/letta-code — MUST stay byte-identical to upstream
  letta-code-ui/   this repo — everything we own
```

**The fork is dev tooling, not a build input.** Nothing in `letta-code/` is compiled into any
image and nothing outside `letta-code-ui/` is in any build context. The app-server and
channel-gateway run upstream's published `letta/letta:<version>`; the UI consumes
`@letta-ai/letta-code` from npm. The checkout exists so `sync-upstream.sh` can diff it and so
you can read the source. A prod host needs only `git` and `docker` — no `bun`, no fork.

This file is the **only** CLAUDE.md. `letta-code/` keeps upstream's own `AGENTS.md`
(and its `CLAUDE.md -> AGENTS.md` symlink) untouched — that is upstream's file, not ours.

## The one hard rule: zero fork delta

`letta-code/` carries **no local changes**. Every capability we need already exists in its
app-server protocol. If something seems to require patching the fork, it is almost certainly
reachable through an existing protocol command — check `letta-code/src/types/protocol_v2.ts`
first. `scripts/sync-upstream.sh` asserts the delta is empty and will fail the sync if it is not.

Building the fork (`bun install && bun run build`) writes only to gitignored paths
(`node_modules/`, `dist/`), so it does not create a delta — but nothing needs that build any
more, so there is rarely a reason to run it.

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
- The BFF's own syncs (reconnect `resubscribe()` and the scope sweep) carry
  `resume_interrupted_turn: true`: this connection is every conversation's execution owner, so
  after an app-server restart a turn left with only replay-unsafe tool calls pending resumes
  immediately (those calls are denied) instead of waiting for a user message. Browser syncs stay
  observer syncs and never get the flag.
- Missed frames are replayed from the BFF's per-conversation ring buffer, keyed by a monotonic
  sequence number. `conversation_messages_list` (cursor `next_before` / `has_more`) is the
  cold-start fallback when a tab was away longer than the buffer.

The same permanent connection is also what boots the cron scheduler and Telegram adapters:
app-server process services start on *first client attach*
(`listener/lifecycle.ts` → `startConnectedListenerRuntime`), so with no client ever connected,
crons never fire.

### All durable state lives under one host root

`LETTA_STATE_DIR` (`docker/compose.yml`) anchors every bind mount:

```
$LETTA_STATE_DIR/
  letta-home/     -> /root/.letta   settings.json (MCP config lives here), global skills
  letta-data/     -> /data          conversations + agent memory (memfs git repos)
  workspaces/     -> /work          agent working directories
```

It defaults to `../..` relative to the compose file, which reproduces the original layout
beside the two repos; prod sets an absolute path. **The default is a trap in a worktree** —
`../..` from `letta-code-ui-worktrees/<feature>/docker/` resolves to the worktrees directory,
not to the real state. Set `LETTA_STATE_DIR` absolutely in `docker/.env` so a compose command
run from anywhere hits the same state, and always do container work from the main checkout.

`bff-data` is the only remaining named volume — web-push device endpoints, rebuildable by
re-subscribing. Everything precious is in that one host directory, so a backup is a single
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
- **MCP is not in the protocol.** Servers live in `/root/.letta/settings.json` under
  `agents[<n>].mcpServers[]` (keyed by `agentId`). We read the file, merge into that one
  agent entry, write it back, and then `execute_command {command_id:"reload"}` — which
  replies "Reloaded settings, local mods, and agent secrets". Merge rather than replace:
  the file holds ~18 unrelated top-level settings including `deviceId`.
- **The agent sandbox needs bubblewrap, two relaxed container profiles AND `CAP_SYS_ADMIN`.**
  `LETTA_FS_SANDBOX=1` on the app-server is what confines agent shells, and letta-code's only
  Linux backend is `bwrap` (`src/sandbox/availability.ts`). The package is added by
  `docker/app-server.Dockerfile`, a thin layer over upstream's published
  `letta/letta:<version>`. The channel-gateway deliberately does **not** carry the flag: it is
  a relay, the app-server runs every turn, and its image is that published one unmodified, so
  it has no bwrap. **Re-verify the sandbox after any base-image change** — the gate degrades
  silently (`warnSandboxBackendUnavailable`, then run unwrapped), so a missing bwrap looks
  exactly like a healthy stack.

  **Measure against `buildBwrapArgs`, never against the probe — they differ, and only the probe
  is forgiving.** `availability.ts` probes with `bwrap --ro-bind / / --unshare-user`, but the
  policy actually run (`src/sandbox/bwrap.ts` `buildBwrapArgs`) never passes `--unshare-user`.
  bubblewrap running as real root then takes its *privileged* path — no user namespace — and
  calls `unshare(CLONE_NEWNS)` directly, which needs `CAP_SYS_ADMIN`. So the probe passes, the
  gate reports a backend, and every wrapped shell command
  dies with `bwrap: Creating new namespace failed: Operation not permitted`. That is exactly how
  the sandbox sat broken-but-green until 2026-08-25. Re-measured against the real arg list:

  | container config | result |
  |---|---|
  | default caps | fails |
  | `cap_drop: ALL` | fails — uid 0 stays on the privileged path |
  | `SYS_ADMIN` alone (default seccomp + AppArmor) | fails |
  | `SYS_ADMIN` + one profile unconfined | fails |
  | `SYS_ADMIN` + `seccomp:unconfined` + `apparmor:unconfined` | **works** |
  | non-root uid + both profiles unconfined, no added caps | works |

  All three of `seccomp:unconfined`, `apparmor:unconfined` and `cap_add: SYS_ADMIN` are
  load-bearing; `privileged` is still not needed. (An earlier note here said `SYS_ADMIN` was
  not needed. It was measured against the probe's arguments, not the policy's.) Running the
  app-server as a non-root uid drops the capability requirement entirely — bwrap then takes the
  unprivileged user-namespace path — but it needs the `letta-home` and `letta-data` trees
  chowned, so it is a migration rather than a flag.

  **The profile is cross-agent, not per-workspace — and that was a deliberate swap.** With
  `LETTA_FS_SANDBOX=1`, `applyShellSandbox` builds `buildCrossAgentSandboxPolicy`: `--bind / /`
  (writes allowed by default), both agents trees (`~/.letta/agents` and
  `<local-backend>/memfs`) masked with an empty tmpfs, and the current agent's own memory roots
  bound back read-write. Measured in the container: own memfs memory dir **writable**, `/tmp`
  **writable**, `/root/.letta` **writable**, other agents' memfs **masked** (`ls` shows only
  this agent), `/work/<other agent>` **writable**.

  The UI used to request `runtime_start.workspace_sandbox {root: /work/<agent-id>,
  isolation_root: /work}` instead. Do not put it back. Three measured reasons:

  1. It is a **write-scoped** profile with exactly ONE writable root
     (`buildWorkspaceSandboxPolicy` → `restrictWrites: true`). Rooted at the agent workspace it
     left the agent's own memory (`/data/local-backend/memfs/<id>/memory`), `/tmp` and
     `/root/.letta` **read-only** — so an agent could not record anything it learned, and
     anything reaching for a temp file failed (a `curl -o /tmp/...` exits 23). `policy.ts` has
     a `baseWritableRoots` field that would express "workspace plus `/tmp` plus memory"
     exactly, but no protocol field reaches it, so it is unobtainable without a fork delta.
  2. Its isolation root was `/work`, so it masked peer **workspaces** while leaving every
     agent's **memory** world-readable. The cross-agent profile inverts that, and memory is the
     part worth hiding.
  3. Coverage was not uniform. `workspaceSandbox` lives on the per-conversation runtime, so
     cron (`cron/scheduler.ts` → `getOrCreateConversationRuntime`) and channel-fired turns got
     no sandbox at all, and a cron-*created* conversation also gets `cwd = /work` rather than
     `/work/<agent-id>`. Worse, a BFF upstream reconnect re-syncs known scopes
     (`bff/src/upstream/connection.ts` `resubscribe()` → `sync {runtime}`), which subscribes the
     connection and creates an unsandboxed runtime; the browser's next `runtime_start` then
     trips `assertRuntimeWorkspaceSandboxChangeAllowed` and `use-conversation.ts` fell back to
     no sandbox **for the life of that conversation**. Two conversations of the same agent an
     hour apart could differ. `LETTA_FS_SANDBOX` is process env, so it covers every shell in
     every conversation — browser, cron, Telegram and subagents alike.

  Scope, so it is not oversold: it confines **spawned shell commands**, cross-agent only.
  Agents are *not* confined to `/work/<agent-id>` — one can still write another's workspace
  files. Reads outside the agents trees are **not** restricted — `policy.ts` says so outright —
  and the network is untouched. In-process file tools are covered separately and
  unconditionally by `evaluateCrossAgentGuard`, which does not depend on this flag. The gate
  degrades silently when no backend is available (`warnSandboxBackendUnavailable`, then run
  unwrapped), so the capability check above belongs in `docker/compose.yml` and nothing in the
  UI reports sandbox state any more.
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
    project- or agent-scoped skill it answers "Skill not found" — which is why the Skills tab
    offers Disable only for `source === "global"`.
  - **An agent can install into any scope except another agent's.** Under the cross-agent
    sandbox its shell can write `/root/.letta/skills` (global) and its own agent memory dir, so
    `skill_enable` from a shell works. Only peer agents' trees are masked. (This was not true
    under the old workspace sandbox, which confined the shell to `/work/<agent-id>` and left
    project scope as the only writable option.)
  - **The advertised list is rebuilt in `turn-setup.ts` and nowhere else.** It starts empty and
    is recomputed at the start of each turn, and no protocol command asks for a fresh one — so
    Settings→Skills is blank until the agent has taken a turn, and after an enable/disable the
    `skills_updated` frame can only mark the list stale, never reload it.
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
  `agent.system` — what the agent editor shows — is a letta-code-**managed** preset, tracked in
  `settings.json` as `systemPromptPreset` + `systemPromptHash` + `systemPromptVersion`. On
  startup `scheduleManagedSystemPromptUpdate` (`agent/system-prompt-versioning.ts`) compares the
  hash and, while it still matches, **overwrites `system`** with the new preset text on a version
  bump. Editing it flips the agent to `systemPromptPreset: "custom"` and opts it out of every
  future refresh. No agent tool writes this field.

  What an agent rewrites when asked to change its own instructions is
  `memory/system/persona.md` in its memfs (`/data/local-backend/memfs/<agent-id>/memory/`, a git
  repo — `git log` there is the provenance). That block is composed into context every turn when
  `memfs: true`, and the UI surfaces it in the **Memory** tab, not the agent editor. Expect
  "I asked it to update its system prompt and the UI shows the old one" — both statements are
  true and about different fields.
- **Memory lives outside every agent workspace, and there are two ways to write it.** The memfs
  repo is `/data/local-backend/memfs/<agent-id>/memory` (`$MEMORY_DIR` in the agent's shell
  env) — never under `/work/<agent-id>`. Agents reach it two ways: the in-process `memory` tool
  (`memory {command:"str_replace", file_path:"system/human.md", reason:…}`, present in
  `ANTHROPIC_DEFAULT_TOOLS`), which writes with node `fs` and commits with `execFile("git")`,
  neither of them sandboxed; or plain `Edit`/`Write`/`Bash` on `$MEMORY_DIR`, which works
  because the cross-agent profile binds the agent's own memory roots read-write. Prefer the
  `memory` tool: the repo carries `pre-commit`/`post-commit` hooks that validate frontmatter,
  and the tool commits for you. `letta memory` (the CLI) has status/diff/backup/export/pull but
  **no write verb** — its own help says "use git commands" — so an agent that goes looking
  there finds nothing and concludes memory is unwritable.
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
  Fixing the cancellation itself needs a fork delta; do not add one.
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
re-pins all six version sites to the new release, and typechecks.

Protocol drift shows up two ways:
1. **Typed** — `web/` and `bff/` import from `@letta-ai/letta-code` (pinned to the npm release
   matching the running image), so `bun run typecheck` fails on any breaking protocol change.
2. **Behavioral** — types will NOT catch these; the sync script flags changes to:
   - `src/websocket/listener/connection-lifecycle.ts` — the turn-cancellation semantics above.
   - `src/channels/gateway-supervisor.ts` and `src/channels/gateway-local.ts` — if the gateway
     ever gains `--ws-auth`, the shared-network-namespace workaround below can be dropped.

### Version pinning

**Sync to a published release tag, never `upstream/main`:** `bun run sync-upstream v<version>`.
The script defaults to `upstream/main`, which is the wrong target here. Everything the stack
runs comes from a **published artifact**: the images are `letta/letta:$LETTA_CODE_VERSION` from
Docker Hub, and the protocol types are `@letta-ai/letta-code@<v>` from npm. A fork sitting one
commit past a tag has nothing to pin to, and quietly stops being the code the app-server runs.
`sync-upstream.sh` now asserts both artifacts exist before re-pinning.

**The version literal lives in six tracked places and they must move together:**

| File | Form |
|---|---|
| `docker/compose.yml` | `LETTA_CODE_VERSION: "${LETTA_CODE_VERSION:-<v>}"` — app-server build arg |
| `docker/compose.yml` | `image: letta/letta:${LETTA_CODE_VERSION:-<v>}` — channel-gateway |
| `docker/app-server.Dockerfile` | `ARG LETTA_CODE_VERSION=<v>` |
| `package.json` | `"@letta-ai/letta-code": "<v>"` |
| `bff/package.json` | same |
| `web/package.json` | same |
| `docker/.env` | `LETTA_CODE_VERSION=<v>` — gitignored, so it drifts unseen |

`scripts/check-version-pin.ts` asserts the six agree and runs first in `bun run verify`.
`docker/.env` is reported but never fatal — it cannot be fixed from a fresh clone.
`sync-upstream.sh` rewrites all six for you.

**The trap that hides a stale pin:** a shell `LETTA_CODE_VERSION` outranks `docker/.env` in
Compose's precedence order. That is how `.env` sat at `0.30.27` through the whole `0.30.29`
cycle without anyone noticing. The pin check now prints a warning for exactly this case.

**A version bump is a full rebuild.** `docker compose -f docker/compose.yml up -d --build` —
app-server, channel-gateway and bff. This is the documented exception to "Only `bff` is rebuilt
in step 4" under Definition of done; that note governs ordinary UI and BFF changes, this one
governs version bumps. Recreating `app-server` drops the BFF's permanent upstream connection,
so any in-flight turn is lost and the cron scheduler and Telegram gateway restart on the BFF's
reconnect. Afterwards re-check the sandbox (`bwrap --version` in the container) — a base image
that lost the package would degrade silently.

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
   and restores `/root/.letta/settings.json`, creates and deletes a cron task).
7. **Pushed to `origin` — but stop and ask first.**

### Stop before pushing

**Never `git push` without asking, every time.** After merging to `main`, halt and ask for
explicit confirmation. Standing approval does not carry over: a yes on one change is not a
yes on the next one.

Pushing is the one step that leaves this machine, and `origin` is the only copy of this
project that is not on one laptop — so it matters, and so it is worth a human deciding.
It comes last, after `deploy-check`, so nothing reaches `origin` that has not been proven
to run in the container first.

`origin` is `dmarchevsky/letta-code-ui`, private, and was empty until the first push. There
is no `main` upstream to track on a fresh clone — the first push of a branch needs
`git push -u origin main`. `.gitignore` covers `docker/.env` and `docker/secrets/`; neither is
tracked, and no secret values are in history. Re-check that before pushing anything new that
touches configuration.

Only `bff` is rebuilt in step 4 — it is the only service carrying our code. Rebuild
`app-server` or `channel-gateway` only when `LETTA_CODE_VERSION` or the fork changes.

**`web/dist` is baked into the bff image, never mounted.** `bff.Dockerfile` builds the SPA
in its `web-build` stage and copies the result into the runtime image; the BFF's only mounts
are the `bff-data` volume and `/work` (read-only) — it takes no configuration from disk at
all. So `docker compose up -d` on its own will happily serve a months-old
UI, and a local `bun run build` changes nothing the container sees. That is the trap step 5
catches: it compares the served `assets/index-*.js` name against the local one.

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
| `bun run sync-upstream` | Sync fork from upstream, report drift, re-pin the version |
| `bun run check-version-pin` | Assert the six letta-code version literals agree (runs inside `verify`) |
| `bun run migrate-state` | One-shot: copy the old `letta-home`/`letta-data` named volumes onto the host |
| `docker compose -f docker/compose.yml build bff` | Rebuild the BFF image — **required** to ship UI changes |
| `docker compose -f docker/compose.yml up -d` | App-server + BFF + channel gateway |
| `git push origin main` | Last step — **ask for confirmation first, every time** |
