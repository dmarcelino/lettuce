---
name: lettuce-ui-conventions
description: lettuce UI conventions that are ours, not the protocol's: pin and archive lists kept in the BFF (pinned-agents.json / archived-agents.json, /api/agents/flags, archive only hides), the single AgentMenu fixed to the viewport because both agent lists scroll in boxes that clip, the two sidebar lists and the .agent-row language with the 3px active bar, useAgentStats only at the desktop width, and ui-check reading the open agent from .agent-row.active[data-agent-id]. Read before touching web/src/components/AgentMenu, the sidebar agent/conversation lists, use-agents, or bff/src/agents/id-list.ts.
---

# Agent list and sidebar UI conventions

Loaded from `AGENTS.md`. Pinning and archiving are not in the app-server protocol, so the whole feature is ours.

Extracted from `AGENTS.md`; keep both in sync when you change either, and keep `docs/upstream-notes.md` pointers working.

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
