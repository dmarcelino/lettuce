import { useEffect, useMemo, useState } from "react";
import { agentActivity } from "../lib/activity.ts";
import { groupByDate, listDate } from "../lib/conversation-groups.ts";
import { statsOf, useAgentStats } from "../state/use-agent-stats.ts";
import type { AgentSummary, AgentsApi } from "../state/use-agents.ts";
import type { SessionApi } from "../state/use-session.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  agents: AgentsApi;
  session: SessionApi;
  onClose: () => void;
  onNewAgent: () => void;
  onEditAgent: (agentId: string) => void;
}

/** Avatar tints, picked by agent id so a given agent keeps its colour. */
const AVATAR_TINTS = ["var(--agent)", "var(--accent)", "#e0af68", "#bb9af7", "#7dcfff", "#f7768e"];

function tintFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return AVATAR_TINTS[Math.abs(hash) % AVATAR_TINTS.length] ?? "var(--accent)";
}

/**
 * Agents and conversations in one full-screen menu, opened from the composer
 * (and the top bar). The selected agent's conversations fill the screen, as
 * cards sectioned by date; your agents sit at the bottom, in thumb reach.
 * Tapping an agent switches to it — `use-agents` then opens its most recent
 * conversation — and the list follows. Each list starts with its own "new"
 * card, in one shared style.
 */
export function Switcher({ agents, session, onClose, onNewAgent, onEditAgent }: Props) {
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [switchedTo, setSwitchedTo] = useState<string | null>(null);

  const stats = useAgentStats(session.request, agents.agents, true);
  const current = agents.agents.find((agent) => agent.id === agents.agentId) ?? null;
  const activity = agentActivity(
    session.activeScopes,
    agents.agentId,
    agents.conversations.map((conversation) => conversation.id),
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (menuFor) setMenuFor(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuFor, onClose]);

  const needle = query.trim().toLowerCase();
  const archivedCount = agents.conversations.filter((c) => c.archived).length;
  const liveCount = agents.conversations.length - archivedCount;
  const groups = useMemo(
    () =>
      groupByDate(
        agents.conversations.filter(
          (conversation) =>
            (showArchived || !conversation.archived || activity.responding.has(conversation.id)) &&
            (!needle || conversation.summary.toLowerCase().includes(needle)),
        ),
      ),
    [agents.conversations, showArchived, needle, activity.responding],
  );

  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const pickAgent = (agent: AgentSummary) => {
    setMenuFor(null);
    setQuery("");
    if (agent.id === agents.agentId) return;
    agents.selectAgent(agent.id);
    setSwitchedTo(agent.name);
  };

  const agentLine = (agent: AgentSummary) => {
    const own = agent.id === agents.agentId ? statsOf(agents.conversations) : stats.get(agent.id);
    const parts: string[] = [];
    if (own) parts.push(`${own.count} conversation${own.count === 1 ? "" : "s"}`);
    return { parts, lastActive: own?.lastActive };
  };

  return (
    <div className="switcher" role="dialog" aria-modal="true" aria-label="Agents and conversations">
      <div className="switcher-panel">
        <header className="switcher-bar">
          <button type="button" className="switcher-back" onClick={onClose}>
            <Icon name="back" /> Chat
          </button>
          <h2>{current?.name ?? "Conversations"}</h2>
          <span className="switcher-bar-spacer" />
        </header>

        <label className="switcher-search">
          <Icon name="search" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${liveCount} conversations`}
            aria-label="Search conversations"
          />
        </label>

        <div className="switcher-list">
          {switchedTo ? (
            <p className="switcher-hint">
              Switched to {switchedTo} · opened its most recent conversation
            </p>
          ) : null}

          <button
            type="button"
            className="switcher-new"
            disabled={busy || !agents.agentId}
            onClick={() =>
              void guard(async () => {
                await agents.createConversation();
                onClose();
              })
            }
          >
            <Icon name="plus" />
            <span>New conversation{current ? ` with ${current.name}` : ""}</span>
          </button>

          {activity.inDefault ? (
            <p className="activity-note small muted">
              <span className="activity-dot" aria-hidden="true" /> Responding in the agent's default
              conversation (a scheduled or channel turn — not listed)
            </p>
          ) : null}

          {groups.map((group) => (
            <section key={group.label}>
              <h3 className="switcher-group">{group.label}</h3>
              {group.items.map((conversation) => {
                const open = conversation.id === agents.conversationId;
                const responding = activity.responding.has(conversation.id);
                return (
                  <div
                    key={conversation.id}
                    className={`switcher-card conversation${open ? " selected" : ""}`}
                  >
                    <button
                      type="button"
                      className="switcher-card-main"
                      onClick={() => {
                        agents.selectConversation(conversation.id);
                        onClose();
                      }}
                    >
                      <span className="switcher-card-title">{conversation.summary}</span>
                      <span className="switcher-card-meta">
                        {listDate(conversation.updatedAt)}
                        {open ? " · open now" : ""}
                        {conversation.archived ? " · archived" : ""}
                        {responding ? <span className="responding"> · responding…</span> : null}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="switcher-more"
                      aria-label={`More for ${conversation.summary}`}
                      aria-expanded={menuFor === conversation.id}
                      onClick={() =>
                        setMenuFor((current) =>
                          current === conversation.id ? null : conversation.id,
                        )
                      }
                    >
                      <Icon name="more" />
                    </button>
                    {menuFor === conversation.id ? (
                      <div className="switcher-menu" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          disabled={busy}
                          onClick={() => {
                            setMenuFor(null);
                            const next = prompt("Conversation name", conversation.summary);
                            if (next && next !== conversation.summary) {
                              void guard(() => agents.renameConversation(conversation.id, next));
                            }
                          }}
                        >
                          <Icon name="edit" /> Rename
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={busy}
                          onClick={() => {
                            setMenuFor(null);
                            void guard(() =>
                              agents.setArchived(conversation.id, !conversation.archived),
                            );
                          }}
                        >
                          <Icon name={conversation.archived ? "unarchive" : "archive"} />{" "}
                          {conversation.archived ? "Unarchive" : "Archive"}
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </section>
          ))}

          {groups.length === 0 ? (
            <p className="muted small switcher-empty">
              {needle ? "No conversation matches." : "No conversations yet."}
            </p>
          ) : null}

          {archivedCount > 0 ? (
            <button
              type="button"
              className="switcher-archived"
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
            </button>
          ) : null}
          {agents.error ? <p className="warning small">{agents.error}</p> : null}
        </div>

        <section className="switcher-agents" aria-label="Agents">
          <h3 className="switcher-group">Agents</h3>
          <button type="button" className="switcher-new" disabled={busy} onClick={onNewAgent}>
            <Icon name="plus" />
            <span>New agent</span>
          </button>
          {agents.agents.map((agent) => {
            const selected = agent.id === agents.agentId;
            const { parts, lastActive } = agentLine(agent);
            const responding = session.activeAgentIds.has(agent.id);
            return (
              <div key={agent.id} className={`switcher-card agent${selected ? " selected" : ""}`}>
                <button
                  type="button"
                  className="switcher-card-main"
                  onClick={() => pickAgent(agent)}
                  aria-current={selected ? "true" : undefined}
                >
                  <span className="switcher-avatar" style={{ background: tintFor(agent.id) }}>
                    {agent.name.trim().charAt(0).toUpperCase() || "?"}
                  </span>
                  <span className="switcher-agent-text">
                    <span className="switcher-card-title">{agent.name}</span>
                    <span className="switcher-card-meta">
                      {parts.join(" · ")}
                      {responding ? (
                        <span className="responding">
                          {parts.length ? " · " : ""}responding now
                        </span>
                      ) : lastActive ? (
                        `${parts.length ? " · " : ""}last active ${listDate(lastActive)}`
                      ) : null}
                    </span>
                  </span>
                  {selected ? <Icon name="check" className="switcher-check" /> : null}
                </button>
                <button
                  type="button"
                  className="switcher-more"
                  aria-label={`Edit ${agent.name}`}
                  title="Edit agent"
                  onClick={() => onEditAgent(agent.id)}
                >
                  <Icon name="more" />
                </button>
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
