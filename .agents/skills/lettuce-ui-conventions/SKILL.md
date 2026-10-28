---
name: lettuce-ui-conventions
description: 'lettuce UI conventions that are ours, not the protocol''s: pin/archive lists kept in the BFF, not in the agent; one AgentMenu fixed to the viewport because the agent surfaces clip it (above a phone ⋯, beside a rail avatar); the desktop rail (avatars named under the face, named panes, Settings foot) beside a conversation panel that is Chat''s alone, pin-toggleable, and named for whose list it is; a phone bar of five equal slots under a header whose left corner carries the open agent's face (`.where-avatar`) as the way into the switcher; both nav surfaces stay mounted and CSS picks one, so ui-check reads the open agent from .rail-agent.active[data-agent-id]; the three-way settings split (Agent tab, Tools tab, global Settings); no native checkbox anywhere (aria-pressed plus .menu-row-box / .chip-check). Read before touching web/src/components/AgentMenu, NavRail, BottomBar, Sidebar, tabs/AgentTab.tsx, tabs/ToolsTab.tsx, GlobalSettings.tsx, lib/tabs.ts, use-agents, or bff/src/agents/id-list.ts.'
---

# Agent list and sidebar UI conventions

Loaded from `AGENTS.md`. Pinning and archiving are not in the app-server protocol, so the whole feature is ours.

- **Pinning and archiving an agent are not in the protocol, so both are ours.** letta-code
  keeps a pinned list in `settings.json` for its CLI picker, but the app-server only sets it at
  creation (`create_agent.pin_global`), and it has no agent archive — its `hidden` flag marks
  subagents (and hidden agents leave `agent_list`), so it must not be borrowed. The BFF keeps
  two id lists (`bff/src/agents/id-list.ts`: `pinned-agents.json`, `archived-agents.json` on
  `bff-data`; `GET /api/agents/flags`, `PUT /api/agents/{pins,archived}/:id`; archiving also
  unpins). Archive only hides: crons, memory and conversations carry on. One `AgentMenu`
  (Edit, Pin, Archive, Delete) serves the phone switcher (opening above its ⋯), every rail avatar
  (opening beside it — the rail is a narrow column, and an avatar's verbs are a right-click), and
  the switcher's rows; it is fixed to the viewport because the agent surfaces scroll in boxes of
  their own, which clip an absolute menu, and closes itself on Back, Escape and presses elsewhere.
  `use-agents` returns `agents` pinned-first; the rail, the bar and the panel hide archived agents,
  and only the switcher brings them back behind "archived agents (N)".
- **Navigation is two surfaces, one per width, and `web/src/lib/tabs.ts` is the pane list they
  share.** Desktop gets a 74px **rail** (`NavRail`: agent avatars **with the name spelled out under the
  face** — an initial is a riddle once two agents start with the same letter — capped at 52vh and
  scrolling on their own so the panes never move, then the named panes, then Settings pinned to the
  foot — there is no More, because a rail has room to name everything. **An avatar answers
  *who*, not *where*:** picking another agent keeps the pane you are on (Files stays Files, with
  their files), because being thrown to Chat made the avatars a place you dared not click while
  something else was open; on Chat it opens the panel, and the open agent's own avatar is the
  "back to my conversations" verb that still jumps to Chat. A kept-open pane has to **follow**
  the agent, which is two mechanics and one exception: the anchor (`App`'s effect takes that
  agent's most recent conversation when a secondary pane is open with nothing selected — Files
  is a conversation's directory and Tasks its runs, and the panel that would supply one is
  hidden there), and Files' own reset (`agentId` changes → the root and its tree clear **to the
  agent's workspace, not to null**: a child's effects run before its parent's, so clearing let
  the init effect recapture the previous agent's `cwd`). `use-conversation` clears `cwd` with
  no scope for the same reason. **Runs is not per-agent** — its lists are the BFF's Codex,
  Claude and remote-pi runs across every agent. The cells are 54px and the
  names clip: the rail's content box is 58px on the wide layout and a wider cell hangs out of the
  column, which is what `ui-check`'s sideways-scroll check is for). Beside it the **panel** (`Sidebar`) is
  conversations and nothing else, and it belongs to Chat: a secondary pane puts it away, and the pin
  in its header (localStorage, pinned by default) decides whether Chat keeps it as a column or
  treats it as a peek that closes on a press anywhere else. It stays **mounted** when hidden — its
  polling is what fills `activeScopes`, so an agent that is answering still lights its avatar. A
  **There is one conversation panel, its head says whose it is, and a hover borrows it.**
  The head carries a face plus a name — the open agent's, or the borrowed one's — because a
  list that says only "Conversations" is silent about which agent the next click acts on.
  Resting on an avatar (120ms of deliberate rest, mouse only) asks `App` to show that agent's
  list in the same panel (`previewId` + `onPreviewAgent`, lists from `use-agent-conversations.ts`),
  read-only while borrowed: no archive, no rename — those belong to the agent whose panel this is.
  A hover is honoured only while the panel is **unpinned** (a pinned column is what you are
  reading, and it does not change agents under you) and only on Chat; the panel holds the borrow
  while the pointer is inside it (`onHold`), and a press or a pointer-out puts it back. Avatar to
  avatar is **one gesture, not a close and an open**: the close armed by leaving the first never
  runs, and once a list is up the next replaces it at once — the 120ms prices an *opening*, not a
  change of mind, and a panel that blinks back to your own list mid-move is the bug.
  Below 900px both are `display: none` and the
  **bottom bar** (`BottomBar`) is the navigation: five equal slots — Chat, Files,
  Tasks, Tools, then More holding Agent, Runs and Settings — and no avatar, because
  a letter in a bar never said which agent it meant. The open agent's **face** is in
  the header's left corner (`.where-avatar`, hidden from 900px, `tintFor` + `initialOf`
  + the responding dot) and opens the same switcher the agent-name button beside it
  does. Identity lives in the header; the bar is panes and nothing else.
  Both nav surfaces stay mounted and CSS picks one, the way the sidebar always did, so `ui-check`
  reads state at either width. Conversation verbs are a hover-revealed `.conversation-archive`
  glyph beside the ⋯ on desktop and the ⋯ alone on a phone (there is no hover on a touch device),
  and archived conversations come back through the centred `.sidebar-archived` link. Counts for
  agents other than the open one come from `useAgentStats`, fetched when the switcher opens.
  ui-check reads the open agent from `.rail-agent.active[data-agent-id]`.
- **Settings are split by scope, and the split is the UI's only statement of it.** The **Agent** tab
  (`web/src/tabs/AgentTab.tsx`) holds what belongs to the selected agent: General (name, model, base
  system prompt, delete), Secrets, Reflection, and the Skills it sees. The **Tools** tab
  (`web/src/tabs/ToolsTab.tsx`) holds which shared tool families that agent is offered and what each
  one points at *for it*. **Settings** (`components/GlobalSettings.tsx`, full screen; wrapping chips
  with short names on a phone, the grouped list beside the section on desktop; reached from the
  rail's foot on desktop and the More sheet on a phone), holds what every agent shares — providers,
  web search, MCP servers, Google, Codex/Claude workers, global skills — plus this device's
  notifications and an About. Where a new setting goes is decided by its backend key, not by taste:
  keyed by `agent_id` → Agent tab; a BFF file or an app-server-wide command → Settings; `runtime`
  scope → next to the conversation (the composer). Feature-gated sections (web search, Google, the
  coding workers) render from `features` in `/api/status`, so a compose token that is off hides the
  whole section rather than showing a disabled one.
- **The Tools tab is chips-with-a-box, not a form.** Each family (Google, Codex, Claude, Remote Pi)
  is a `.chip-pair`: a small box button that allows or blocks the family, then a chip that opens its
  pane. The box writes the access record immediately — a toggle has no other fields to wait for —
  while a pane with several fields (Remote Pi's own host/workdir) has its own **Save**. Both halves
  of the pair are `<button>`s: nothing in the app uses `<input type="checkbox">` (the platform box
  renders in its own colour and size), so state is a boolean ARIA attribute plus a CSS class —
  `aria-pressed` with `.menu-row-box.on` for a menu row, `role="checkbox"` + `aria-checked` with
  `.chip-check.on` for a chip box, which is what `ui-check` counts (`input[type=checkbox]` must be
  0 anywhere in the DOM). The Agent tab's chip list is exactly
  `General/Secrets/Reflection/Skills` since Tools moved out, and `GlobalSettings`'s
  `SHARED_NOTE` has to name **both** per-agent tabs. Inside a settings section body
  `.section-note` is a **heading** (12px bold, like "Change password") and the prose that
  explains the rows is `.section-copy` — their inset and size, with the banner's code chip —
  so a section is rows, one statement, one provenance line; a `p.warning` that also carries a
  `.section-note` renders the banner's text at heading weight, which is what made a section
  read as clutter.
