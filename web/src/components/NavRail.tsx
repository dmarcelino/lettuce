import { useEffect, useRef, useState } from "react";
import {
  AGENT_BLOCK_MIN,
  agentBlockMax,
  clampAgentBlock,
  clearAgentBlock,
  readAgentBlock,
  writeAgentBlock,
} from "../lib/rail-size.ts";
import type { Tab } from "../lib/tabs.ts";
import type { AgentSummary, AgentsApi } from "../state/use-agents.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { AgentMenu } from "./AgentMenu.tsx";
import { DeleteAgentSheet } from "./DeleteAgentSheet.tsx";
import type { IconName } from "./Icon.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  agents: AgentsApi;
  /** For the green dot on an avatar: any of that agent's conversations are responding. */
  activeAgentIds: ReadonlySet<string>;
  /** Whether the `Runs` pane exists at all on this deployment. */
  runsEnabled: boolean;
  tab: Tab;
  onSelectPane: (tab: Tab) => void;
  /** Tapping the open agent's avatar also brings the conversation panel back. */
  onOpenPanel: () => void;
  /** Resting on an avatar asks the one conversation panel to show that agent; `null`
   * is the pointer leaving. App decides whether the ask is honoured. */
  onPreviewAgent: (agentId: string | null) => void;
  /** Resting on the **open** agent's avatar asks for its own list back, not a borrow. */
  onOwnAvatar: () => void;
  onOpenSettings: () => void;
  onOpenSwitcher: () => void;
  onEditAgent: (agentId: string) => void;
}

/** The panes the rail offers, in order. `Runs` is inserted only when enabled. */
function paneItems(runsEnabled: boolean): { tab: Tab; label: string; icon: IconName }[] {
  const items: { tab: Tab; label: string; icon: IconName }[] = [
    { tab: "Chat", label: "Chat", icon: "chats" },
    { tab: "Files", label: "Files", icon: "folder" },
    { tab: "Tasks", label: "Tasks", icon: "task" },
  ];
  if (runsEnabled) items.push({ tab: "Runs", label: "Runs", icon: "terminal" });
  items.push(
    { tab: "Tools", label: "Tools", icon: "model" },
    { tab: "Agent", label: "Agent", icon: "shield" },
  );
  return items;
}

/**
 * The desktop rail: the agents, then the panes, then the two settings verbs.
 *
 * It replaces the old top tab strip and the sidebar's agent list, which is why
 * one column answers "which agent" and "which pane" and the panel beside it only
 * ever shows conversations. Chat is primary in the literal sense: it is the
 * default pane, the only one with a composer, and the only one with a panel.
 */
export function NavRail({
  agents,
  activeAgentIds,
  runsEnabled,
  tab,
  onSelectPane,
  onOpenPanel,
  onPreviewAgent,
  onOwnAvatar,
  onOpenSettings,
  onOpenSwitcher,
  onEditAgent,
}: Props) {
  const [menu, setMenu] = useState<{ agent: AgentSummary; anchor: DOMRect } | null>(null);
  const [deleting, setDeleting] = useState<AgentSummary | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // How tall the agent block is: dragged by the divider between it and the panes,
  // and kept in this browser (`lib/rail-size.ts`). null is the stylesheet default.
  const blockRef = useRef<HTMLDivElement>(null);
  const [blockPx, setBlockPx] = useState<number | null>(() => readAgentBlock());
  const [dragging, setDragging] = useState(false);
  const livePx = useRef<number | null>(blockPx);

  /** The height the block is drawn at, never more than the window can show. Dragged
   * as a height rather than a cap: dragging a cap whose content already fits moves
   * nothing on screen, so the one gesture that is supposed to answer immediately
   * would be silent until you had enough agents to notice. */
  const blockHeight = blockPx === null ? null : clampAgentBlock(blockPx, window.innerHeight);

  /**
   * One drag: the block grows by however far the pointer went down, clamped so the
   * panes and the footer can never be crowded out. Pointer capture would be the
   * tidy form, but the pointer leaves the 9px grip the moment it moves, so the
   * window owns the move and the up.
   */
  const startDrag = (event: React.PointerEvent) => {
    const el = blockRef.current;
    if (!el || event.button !== 0) return;
    event.preventDefault();
    const startH = el.getBoundingClientRect().height;
    const startY = event.clientY;
    setDragging(true);
    const move = (moveEvent: PointerEvent) => {
      const next = clampAgentBlock(startH + (moveEvent.clientY - startY), window.innerHeight);
      livePx.current = next;
      setBlockPx(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(false);
      if (livePx.current !== null) writeAgentBlock(livePx.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** The keyboard's version of the same drag, for anyone not holding a mouse. */
  const nudgeBlock = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 120 : 40;
    const current = blockRef.current?.getBoundingClientRect().height ?? 0;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = clampAgentBlock(
        current + (event.key === "ArrowDown" ? step : -step),
        window.innerHeight,
      );
      livePx.current = next;
      setBlockPx(next);
      writeAgentBlock(next);
    } else if (event.key === "Home") {
      event.preventDefault();
      livePx.current = null;
      setBlockPx(null);
      clearAgentBlock();
    }
  };

  // A hover is a *deliberate* rest, not a sweep of the pointer down the rail: 120ms
  // is the point where passing through stops opening the panel. What it opens is the
  // one conversation panel, showing whichever agent is under the pointer — App decides
  // whether the ask is honoured (a pinned panel is already on screen, and a secondary
  // pane has no panel to give without changing the pane under someone who is reading).
  // The close waits 300ms so the pointer can cross the gap to the panel; if it arrives,
  // the panel reports the hold and the preview stays rather than snapping shut.
  // Which agent the panel is showing right now, as far as the rail knows: moving
  // from one avatar to the next is one gesture, not a close and an open.
  const shown = useRef<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armPreview = (agentId: string) => {
    // The close armed by leaving the avatar you came from never gets to run: a panel
    // that blinks back to your own list and opens again is a flicker, and the pointer
    // never asked for it. And once a list is already up, the next one replaces it at
    // once — the 120ms is the price of *opening*, not of changing your mind.
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(
      () => {
        shown.current = agentId;
        onPreviewAgent(agentId);
      },
      shown.current === null ? 120 : 0,
    );
  };
  const armOwn = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(onOwnAvatar, shown.current === null ? 120 : 0);
  };
  const leaveAvatar = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      shown.current = null;
      onPreviewAgent(null);
    }, 300);
  };
  // Whatever is pending when the rail goes away never becomes a panel.
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  // A menu hanging from an avatar moves with it, so anything that moves the avatar —
  // the window resizing — closes it rather than leaving it floating in the old place.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [menu]);

  const pick = (agent: AgentSummary) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    shown.current = null;
    if (agent.id === agents.agentId) {
      // Same agent: the pane is already this agent's, so the useful verb is the
      // one thing the rail has left — bring the conversations back.
      onSelectPane("Chat");
      onOpenPanel();
      return;
    }
    // Another agent answers "who", not "where". Switching while you are looking at
    // Files stays on Files, with the new agent's files: being thrown to Chat made the
    // avatars a place you dared not click while something else was open.
    agents.selectAgent(agent.id);
    if (tab === "Chat") onOpenPanel();
  };

  const visible = agents.agents.filter((agent) => !agents.archivedAgents.has(agent.id));
  const panes = paneItems(runsEnabled);

  return (
    <nav className={`rail${dragging ? " dragging" : ""}`} aria-label="Agents and sections">
      <div
        ref={blockRef}
        className="rail-agents"
        style={
          blockHeight === null
            ? undefined
            : { height: `${blockHeight}px`, maxHeight: `${blockHeight}px` }
        }
        onScroll={() => setMenu(null)}
      >
        {visible.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={[
              "rail-agent",
              agent.id === agents.agentId ? "active" : "",
              agents.pinned.has(agent.id) ? "pinned" : "",
              activeAgentIds.has(agent.id) ? "responding" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            data-agent-id={agent.id}
            title={
              agents.pinned.has(agent.id)
                ? `${agent.name} (pinned) — conversations`
                : `${agent.name} — conversations`
            }
            onClick={() => pick(agent)}
            onPointerEnter={(event) => {
              if (event.pointerType !== "mouse") return;
              if (agent.id === agents.agentId) armOwn();
              else armPreview(agent.id);
            }}
            onPointerLeave={leaveAvatar}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ agent, anchor: event.currentTarget.getBoundingClientRect() });
            }}
          >
            <AgentAvatar agentId={agent.id} name={agent.name} pref={agents.avatars[agent.id]} />
            <span className="rail-agent-name">{agent.name}</span>
          </button>
        ))}
        <button
          type="button"
          className="rail-agent rail-all"
          onClick={onOpenSwitcher}
          title="All agents: search, archived, new agent"
          aria-label="All agents"
        >
          <Icon name="more" />
          <span className="rail-agent-name">all</span>
        </button>
      </div>

      {/* The one draggable seam in the app: the avatars are the only block whose
          right size depends on how many agents a person has. */}
      <hr
        className={`rail-split${dragging ? " dragging" : ""}`}
        aria-orientation="horizontal"
        aria-label="Agent list height"
        aria-valuenow={blockHeight === null ? undefined : blockHeight}
        aria-valuemin={AGENT_BLOCK_MIN}
        aria-valuemax={agentBlockMax(window.innerHeight)}
        tabIndex={0}
        title="Drag to show more or fewer agents"
        onPointerDown={startDrag}
        onKeyDown={nudgeBlock}
      />

      {panes.map((pane) => (
        <button
          key={pane.tab}
          type="button"
          className={`rail-item${tab === pane.tab ? " active" : ""}`}
          aria-current={tab === pane.tab ? "page" : undefined}
          onClick={() => onSelectPane(pane.tab)}
        >
          <Icon name={pane.icon} />
          {pane.label}
        </button>
      ))}

      <div className="rail-foot">
        <button
          type="button"
          className="rail-item"
          onClick={onOpenSettings}
          title="Settings for every agent"
        >
          <Icon name="settings" />
          Settings
        </button>
      </div>

      {menu ? (
        <AgentMenu
          agentName={menu.agent.name}
          pinned={agents.pinned.has(menu.agent.id)}
          archived={agents.archivedAgents.has(menu.agent.id)}
          anchor={menu.anchor}
          placement="beside"
          onEdit={() => {
            setMenu(null);
            if (menu.agent.id !== agents.agentId) agents.selectAgent(menu.agent.id);
            onEditAgent(menu.agent.id);
          }}
          onTogglePin={() => {
            setMenu(null);
            void agents.setPinned(menu.agent.id, !agents.pinned.has(menu.agent.id));
          }}
          onToggleArchive={() => {
            setMenu(null);
            void agents.setAgentArchived(menu.agent.id, !agents.archivedAgents.has(menu.agent.id));
          }}
          onDelete={() => {
            setMenu(null);
            setDeleting(menu.agent);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {deleting ? (
        <DeleteAgentSheet agents={agents} agent={deleting} onClose={() => setDeleting(null)} />
      ) : null}
    </nav>
  );
}
