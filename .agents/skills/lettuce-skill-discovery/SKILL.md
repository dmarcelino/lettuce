---
name: lettuce-skill-discovery
description: 'lettuce skill-scope mechanics: the four discovery scopes (bundled, global, agent memfs, project /work/<agent-id>/.agents/skills) and their priority, why skill_enable always means global and skill_disable refuses a real directory, the hidden bundled-skill set for local agents, why the BFF re-implements discovery instead of reading protocol state, and its read-only mounts. Read before touching bff/src/skills/, docker/agent-skills/, Settings → Global skills, the Agent → Skills tab, or anything that writes /root/.letta/skills.'
---

# How skills are discovered, listed and enabled

Loaded from `AGENTS.md`. Four scopes, none of them per-conversation.

Extracted from `AGENTS.md`; keep both in sync when you change either, and keep `docs/upstream-notes.md` pointers working.

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
    counts as `agent`) and serves `GET /api/skills?agent_id=&cwd=`. The hidden set is
    `LOCAL_AGENT_EXCLUDED_BUNDLED_SKILLS` (`image-generation`, `managing-shared-memory`,
    `working-across-computers`, and since 0.34 the Cloud-only Memory Palace's
    `curating-memory-palace`); since 0.34.1 upstream applies it as a filter at the end of
    `discoverSkills` (`isSkillAvailableForAgent` — a `bundled` skill with a hidden id only for
    local agents, so a local agent's OWN copy of that id in a higher scope survives), and the
    mirror matches that structure. Bundled skills live only in
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
