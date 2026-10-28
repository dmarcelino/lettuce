import { useEffect, useRef, useState } from "react";
import { agentActivity } from "../lib/activity.ts";
import { initialOf, tintFor } from "../lib/agent-tint.ts";
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
  onOpenSettings,
  onOpenSwitcher,
  onEditAgent,
}: Props) {
  const [menu, setMenu] = useState<{ agent: AgentSummary; anchor: DOMRect } | null>(null);
  const [deleting, setDeleting] = useState<AgentSummary | null>(null);
  const [hover, setHover] = useState<{ agent: AgentSummary; anchor: DOMRect } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const card = useAgentConversations(request);

  // A hover is a *deliberate* rest, not a sweep of the pointer down the rail:
  // 120ms is the point where passing through stops opening cards.
  const armHover = (agent: AgentSummary, anchor: DOMRect) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      setHover({ agent, anchor });
      card.load(agent.id);
    }, 120);
  };
  const disarmHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  // Whatever is pending when the rail goes away never becomes a card.
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );
  // The card would otherwise float wherever its avatar was when the rail began
  // to scroll, exactly like the agent menu, which the caller closes on scroll.
  useEffect(() => {
    if (!menu && !hover) return;
    const onScroll = () => {
      setMenu(null);
      setHover(null);
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
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
    <nav className="rail" aria-label="Agents and sections">
      <div className="rail-agents" onScroll={() => setHover(null)}>
        {visible.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={[
              "rail-agent",
              agent.id === agents.agentId ? "active" : "",
              activeAgentIds.has(agent.id) ? "responding" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            data-agent-id={agent.id}
            title={`${agent.name} — conversations`}
            onClick={() => pick(agent)}
            onPointerEnter={(event) =>
              event.pointerType === "mouse" &&
              agent.id !== agents.agentId &&
              armHover(agent, event.currentTarget.getBoundingClientRect())
            }
            onPointerLeave={disarmHover}
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

      <span className="rail-sep" aria-hidden="true" />

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
        <div onPointerLeave={() => setHover(null)}>
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
