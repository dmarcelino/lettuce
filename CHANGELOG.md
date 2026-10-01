# Changelog

All notable user-facing changes to lettuce, newest first. Version tags and
`VERSION` are defined in CLAUDE.md ("Versioning and tags").

## [Unreleased]

## [v0.3.1-letta_0.33.7] - 2026-10-01

### Fixed
- The context gauge shows the real limit on first load (no more transient 128k default) and appears before the first turn as "— / 256k".

## [v0.3.0-letta_0.33.7] - 2026-10-01

### Added
- COMPOSE_PROFILES now gates features as well as containers: `codex` and `claude` install their CLI into the app-server image, and the `search`/`google`/`codex`/`claude` tokens decide which Settings sections, run lists and Agent → Tools rows exist. Changing a coding token requires an app-server rebuild.

### Changed
- Slash-command popup rows fit one line each: the description sits beside the command name and truncates instead of wrapping.

### Fixed
- The slash-command popup scrolls to keep the highlighted command visible when you arrow through it.

### Removed
- The composer's slash-command button and Commands sheet; type `/` in the input to run a command.

## [v0.2.0-letta_0.33.7] - 2026-10-01

### Added
- Claude Code coding workers: enable in Settings → Claude Code against any Anthropic-compatible endpoint; full run viewer under Tasks → Claude runs, per-agent allow/block in Agent → Tools.

## [v0.1.5-letta_0.33.7] - 2026-09-30

### Added
- Pulsing status dot lists responding conversations and jumps to any of them.

## [v0.1.4-letta_0.33.7] - 2026-09-30

### Added
- Queue-aware send button: while the agent works, press queues your message and the red corner of the split button stops it.
- Queued messages show as chips above the composer with remove and force-send; a green "Agent is working" line sits above the input.

### Fixed
- The working indicator stays lit across queued turns and the force-send seam.

## [v0.1.3-letta_0.33.7] - 2026-09-29

### Added
- Run every container in a configurable timezone.

## [v0.1.2-letta_0.33.7] - 2026-09-29

### Added
- Edit text and markdown files, and create new files, from the Files tab.

## [v0.1.1-letta_0.33.7] - 2026-09-29

### Changed
- The app is now Lettuce: rebranded UI, BFF strings and docs; About no longer shows a letta-code version row.

## [v0.1.0-letta_0.33.7] - 2026-09-29

### Added
- Mobile-first web UI for a self-hosted local Letta agent: chat with transcript grouping, tool approvals, message queue and task-notification cards.
- Manage agents from the UI: create, edit, pin, archive and delete, on phone and desktop.
- Files, Memory and Tasks tabs: browse the agent workspace, download files, preview markdown, read agent memory and background runs.
- Global Settings screen: providers, web search, MCP servers, Google, Codex workers, global skills, notifications and About.
- Sign in through Cloudflare Access, or a local dev bypass when running without it.
- Installable PWA with web push notifications when a finished turn is not being watched.
- Google integration (Gmail, Calendar, Tasks, Contacts) at access levels only the user can set, with reconnect links when access is lost.
- Native `web_search` and `fetch_webpage` tools for every agent, with a SearXNG sidecar and DuckDuckGo fallback.
- Per-agent tool access (Agent → Tools): cut Google down to read-only or off, and allow or block Codex workers per agent.
- One shared MCP list managed from Settings, reachable by agents through `mcp_search` / `mcp_call` native tools.
- Codex workers: delegate a task to a Codex CLI worker and watch its run from the Tasks tab.
- Telegram channel support, opt-in behind the `telegram` compose profile.
- Shared MCP list plus DuckDuckGo search as its first server.
- Give the local LLM up to 30 minutes to start responding, configurable per provider.
- Come back to the agent and conversation you left; conversations are auto-titled.

### Fixed
- Reconnecting Google no longer revokes the token it just obtained.
- A Google API switched off in its Cloud project is reported as such, not as a lost sign-in.
- Stop reports honestly, and each tool call shows one result row.
- The context gauge shows one usage per conversation, counting the prompt cache.
