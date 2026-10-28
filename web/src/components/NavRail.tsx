import { useEffect, useRef, useState } from "react";
import { agentActivity } from "../lib/activity.ts";
import { initialOf, tintFor } from "../lib/agent-tint.ts";
import {
  AGENT_BLOCK_MIN,
  agentBlockMax,
  clampAgentBlock,
  clearAgentBlock,
  readAgentBlock,
  writeAgentBlock,
} from "../lib/rail-size.ts";
import type { Tab } from "../lib/tabs.ts";
import { useAgentConversations } from "../state/use-agent-conversations.ts";
import type { AgentSummary, AgentsApi } from "../state/use-agents.ts";
import type { SessionApi } from "../state/use-session.ts";
import { AgentMenu } from "./AgentMenu.tsx";
import { ConversationFlyout } from "./ConversationFlyout.tsx";
import { DeleteAgentSheet } from "./DeleteAgentSheet.tsx";
import type { IconName } from "./Icon.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  agents: AgentsApi;
  /** For the green dot on an avatar: any of that agent's conversations are responding. */
  activeAgentIds: ReadonlySet<string>;
  /** Scope keys of responding conversations, for the hover card's per-conversation dots. */
  activeScopes: ReadonlySet<string>;
  request: SessionApi["request"];
  /** Whether the `Runs` pane exists at all on this deployment. */
  runsEnabled: boolean;
  tab: Tab;
  onSelectPane: (tab: Tab) => void;
  /** Tapping the open agent's avatar also brings the conversation panel back. */
  onOpenPanel: () => void;
  /** Whether the panel is on screen showing this agent, so a hover does not repeat it. */
  panelOpen: boolean;
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
  activeScopes,
  request,
  runsEnabled,
  tab,
  onSelectPane,
  onOpenPanel,
  panelOpen,
  onOpenSettings,
  onOpenSwitcher,
  onEditAgent,
}: Props) {
  const [menu, setMenu] = useState<{ agent: AgentSummary; anchor: DOMRect } | null>(null);
  const [deleting, setDeleting] = useState<AgentSummary | null>(null);
  const [hover, setHover] = useState<{ agent: AgentSummary; anchor: DOMRect } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const card = useAgentConversations(request);

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

  // A hover is a *deliberate* rest, not a sweep of the pointer down the rail:
  // 120ms is the point where passing through stops opening cards. The open agent
  // answers a hover with its own panel rather than a card of it — a card beside
  // the panel showing the same list is a duplicate — and on a secondary pane,
  // where the panel cannot appear without changing the pane under someone who is
  // reading it, it falls back to the card.
  const armHover = (agent: AgentSummary, anchor: DOMRect) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      if (agent.id === agents.agentId) {
        if (panelOpen) return;
        if (tab === "Chat") onOpenPanel();
        else {
          setHover({ agent, anchor });
          card.load(agent.id);
        }
        return;
      }
      setHover({ agent, anchor });
      card.load(agent.id);
    }, 120);
  };
  const disarmHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  // Leaving the avatar must eventually close the card — a card that stays open
  // after the pointer walks away is a second panel nobody asked for — but the
  // pointer has to cross the gap to reach it, so the close waits long enough for
  // that trip and is cancelled if the pointer arrives.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveAvatar = () => {
    disarmHover();
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHover(null), 300);
  };
  const enterCard = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const leaveCard = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setHover(null);
  };
  // Whatever is pending when the rail goes away never becomes a card.
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  // The card hangs from an avatar, so anything that moves the avatar moves the
  // card out of truth: scrolling the agent block, or the window resizing. It is
  // deliberately NOT every scroll in the document — scrolling the card's own list
  // is the one scroll a person reaches for first, and closing on it reads as the
  // card running away (measured: the wheel over the list dismissed it).
  useEffect(() => {
    if (!menu && !hover) return;
    const close = () => {
      setMenu(null);
      setHover(null);
    };
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [menu, hover]);

  const pick = (agent: AgentSummary) => {
    disarmHover();
    setHover(null);
    if (agent.id === agents.agentId) {
      // Same agent: the pane is already this agent's, so the useful verb is the
      // one thing the rail has left — bring the conversations back.
      onSelectPane("Chat");
      onOpenPanel();
      return;
    }
    agents.selectAgent(agent.id);
    onSelectPane("Chat");
    onOpenPanel();
  };

  const visible = agents.agents.filter((agent) => !agents.archivedAgents.has(agent.id));
  const panes = paneItems(runsEnabled);
  const hoverActivity = hover
    ? agentActivity(
        activeScopes,
        hover.agent.id,
        card.conversations.map((conversation) => conversation.id),
      ).responding
    : new Set<string>();

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
        onScroll={() => setHover(null)}
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
            onPointerEnter={(event) =>
              event.pointerType === "mouse" &&
              armHover(agent, event.currentTarget.getBoundingClientRect())
            }
            onPointerLeave={leaveAvatar}
            onContextMenu={(event) => {
              event.preventDefault();
              setHover(null);
              setMenu({ agent, anchor: event.currentTarget.getBoundingClientRect() });
            }}
          >
            <span className="agent-avatar" style={{ background: tintFor(agent.id) }}>
              {initialOf(agent.name)}
            </span>
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

      {hover ? (
        <div onPointerEnter={enterCard} onPointerLeave={leaveCard}>
          <ConversationFlyout
            agentName={hover.agent.name}
            anchor={hover.anchor}
            conversations={card.conversations}
            responding={hoverActivity}
            respondingCount={hoverActivity.size}
            loading={card.loading}
            failed={card.failed}
            conversationId={hover.agent.id === agents.agentId ? agents.conversationId : null}
            onPick={(conversationId) => {
              setHover(null);
              if (hover.agent.id !== agents.agentId) agents.selectAgent(hover.agent.id);
              agents.selectConversation(conversationId);
              onSelectPane("Chat");
              onOpenPanel();
            }}
            onNewConversation={() => {
              setHover(null);
              if (hover.agent.id !== agents.agentId) agents.selectAgent(hover.agent.id);
              void agents.createConversation();
              onSelectPane("Chat");
              onOpenPanel();
            }}
            onSearchAll={() => {
              setHover(null);
              onOpenSwitcher();
            }}
            onClose={() => setHover(null)}
          />
        </div>
      ) : null}

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
