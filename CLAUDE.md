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
- **MCP is not in the protocol.** Servers live in `/root/.letta/settings.json` under
  `agents[<n>].mcpServers[]` (keyed by `agentId`). We read the file, merge into that one
  agent entry, write it back, and then `execute_command {command_id:"reload"}` — which
  replies "Reloaded settings, local mods, and agent secrets". Merge rather than replace:
  the file holds ~18 unrelated top-level settings including `deviceId`.
- **The agent sandbox needs bubblewrap, two relaxed container profiles AND `CAP_SYS_ADMIN`.**
  `LETTA_FS_SANDBOX=1` on the app-server is what confines agent shells, and letta-code's only
  Linux backend is `bwrap` (`src/sandbox/availability.ts`). The package is added by
  `docker/app-server.Dockerfile`, a thin layer over the fork's own image (built via
  `bun run build-images`). The channel-gateway deliberately does **not** carry the flag: it is
  a relay, the app-server runs every turn, and the gateway image has no bwrap.

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
  unprivileged user-namespace path — but it needs the `letta-home` and `letta-data` volumes
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

### Version pinning

**Sync to a published release tag, never `upstream/main`:** `bun run sync-upstream v<version>`.
The script defaults to `upstream/main`, which is the wrong target here. `app-server.Dockerfile`
builds `FROM letta-app-server-base:$LETTA_CODE_VERSION`, and that base installs
`@letta-ai/letta-code@$LETTA_CODE_VERSION` **from npm** — so the container can only ever run a
released version. A fork sitting one commit past a tag has nothing to pin to, and quietly stops
being the code the app-server runs. Check the tag is published first: `npm view
@letta-ai/letta-code@<version> version`.

**The version literal lives in four places and they must move together:**

| File | Form |
|---|---|
| `docker/compose.yml` | `LETTA_CODE_VERSION: "${LETTA_CODE_VERSION:-<v>}"` — **twice**, `app-server` and `channel-gateway` |
| `scripts/build-images.sh` | the `${LETTA_CODE_VERSION:-<v>}` default |
| `docker/app-server.Dockerfile` | `ARG LETTA_CODE_VERSION=<v>` |
| `docker/.env` | `LETTA_CODE_VERSION=<v>` — gitignored, so it drifts unseen |

Nothing asserts they agree. After bumping, confirm with a single
`grep -rn LETTA_CODE_VERSION docker/ scripts/`.

**The trap that hides a stale pin:** a shell `LETTA_CODE_VERSION` outranks `docker/.env` in
Compose's precedence order, and `build-images.sh` exports one. So `bun run build-images` builds
the *right* version while `docker compose build app-server` on its own silently builds the
`.env` version. That is exactly how `.env` sat at `0.30.27` through the whole `0.30.29` cycle
without anyone noticing — every build had gone through `build-images.sh`.

**A version bump is a full rebuild.** `bun run build-images` then
`docker compose -f docker/compose.yml up -d` — base, app-server, channel-gateway and bff. This
is the documented exception to "Only `bff` is rebuilt in step 4" under Definition of done; that
note governs ordinary UI and BFF changes, this one governs version bumps. Recreating
`app-server` drops the BFF's permanent upstream connection, so any in-flight turn is lost and
the cron scheduler and Telegram gateway restart on the BFF's reconnect.

## Git workflow

Worktrees per feature, feature branches, direct merge to `main`, no PRs.

## Definition of done

Work is **not done**, and must not be reported as done, until every line below passes.
This list exists because a change was once reported as complete when it had been
typechecked and built but never committed, never merged, and never deployed — the
container was still serving the previous bundle, and only the user noticed.

Passing typecheck is not done. Passing tests is not done. **Running in the container is done.**

1. **`bun run verify` green** — lint, typecheck, tests, build. Fails fast; later stages
   do not run once one fails.
2. **Committed** on a feature branch and merged to `main`.
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
`git push -u origin main`. `.gitignore` covers `docker/.env`, `config/users.json` and
`docker/secrets/`; none are tracked, and no secret values are in history. Re-check that
before pushing anything new that touches configuration.

Only `bff` is rebuilt in step 4 — it is the only service carrying our code. Rebuild
`app-server` or `channel-gateway` only when `LETTA_CODE_VERSION` or the fork changes.

**`web/dist` is baked into the bff image, never mounted.** `bff.Dockerfile` builds the SPA
in its `web-build` stage and copies the result into the runtime image; the only bind mount
is `config/users.json`. So `docker compose up -d` on its own will happily serve a months-old
UI, and a local `bun run build` changes nothing the container sees. That is the trap step 5
catches: it compares the served `assets/index-*.js` name against the local one.

Lint policy: `bun run lint` fails on Biome **errors** only. Warnings are visible but do not
block — a handful are load-bearing (see the comments in `biome.jsonc` for why
`useExhaustiveDependencies` is a warning here: satisfying it would reintroduce the unbounded
app-server request loop that `use-session.ts` documents).

## Commands

| Command | What it does |
|---|---|
| `bun run verify` | **The gate.** lint → typecheck → test → build, fail-fast |
| `bun run deploy-check` | Asserts the running container serves the merged code, and is healthy |
| `bun run ui-check` | Layout/interaction assertions in a real browser; screenshots to `.ui-check/` |
| `bun run lint` | Biome check (errors fail, warnings do not) |
| `bun run format` | Biome check with safe fixes applied |
| `bun run typecheck` | Typecheck both packages — the protocol-drift detector |
| `bun run test` | `bun:test` unit tests |
| `bun run build` | Builds the SPA into `web/dist` (runs `tsc --noEmit` first) |
| `bun run dev` | BFF + Vite dev server |
| `bun run smoke` | Live acceptance suite against a running stack — mutates state |
| `bun run sync-upstream` | Sync fork from upstream and report drift |
| `bun run build-images` | Build the app-server base tag, then all compose images — **required** after changing `docker/app-server.Dockerfile` or the fork version |
| `docker compose -f docker/compose.yml build bff` | Rebuild the BFF image — **required** to ship UI changes |
| `docker compose -f docker/compose.yml up -d` | App-server + BFF + channel gateway |
| `git push origin main` | Last step — **ask for confirmation first, every time** |
