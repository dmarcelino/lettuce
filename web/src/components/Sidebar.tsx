import { useEffect, useRef, useState } from "react";
import { agentActivity } from "../lib/activity.ts";
import type { AgentsApi } from "../state/use-agents.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  agents: AgentsApi;
  open: boolean;
  onClose: () => void;
  onNewAgent: () => void;
  onEditAgent: (agentId: string) => void;
  /** Scope keys of conversations with a response in progress; see `SessionApi.activeScopes`. */
  activeScopes: ReadonlySet<string>;
  activeAgentIds: ReadonlySet<string>;
}

export function Sidebar({
  agents,
  open,
  onClose,
  onNewAgent,
  onEditAgent,
  activeScopes,
  activeAgentIds,
}: Props) {
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);

  const activity = agentActivity(
    activeScopes,
    agents.agentId,
    agents.conversations.map((conversation) => conversation.id),
  );

  // A responding archived conversation stays visible: hiding the one thing
  // that is busy would defeat the indicator.
  const visible = agents.conversations.filter(
    (conversation) =>
      showArchived || !conversation.archived || activity.responding.has(conversation.id),
  );

  // A busy conversation the list has never heard of was created after it was
  // fetched (a cron that starts a new conversation per run). Refetch once per
  // such id; if it still is not there, the notice below says so instead.
  const refetchedFor = useRef(new Set<string>());
  const unlistedKey = activity.unlisted.join(",");
  useEffect(() => {
    const agentId = agents.agentId;
    if (!agentId || !unlistedKey) return;
    const fresh = unlistedKey.split(",").filter((id) => !refetchedFor.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) refetchedFor.current.add(id);
    void agents.refreshConversations(agentId);
  }, [agents.agentId, unlistedKey]);

  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {open ? (
        <button type="button" className="scrim" onClick={onClose} aria-label="Close" />
      ) : null}

      <aside className={`sidebar${open ? " open" : ""}`}>
        <div className="sidebar-section">
          <div className="row-between">
            <label htmlFor="agent-select">Agent</label>
            <span className="row-actions">
              <button
                type="button"
                className="link"
                title="Edit agent"
                disabled={busy || !agents.agentId}
                onClick={() => agents.agentId && onEditAgent(agents.agentId)}
                aria-label="Edit agent"
              >
                <Icon name="edit" />
              </button>
              <button
                type="button"
                className="link"
                disabled={busy}
                onClick={onNewAgent}
                aria-label="New agent"
              >
                <Icon name="plus" /> New
              </button>
            </span>
          </div>
          <select
            id="agent-select"
            value={agents.agentId ?? ""}
            onChange={(event) => agents.selectAgent(event.target.value)}
          >
            {agents.agents.length === 0 ? <option value="">No agents</option> : null}
            {agents.agents.map((agent) => (
              // A native option cannot hold markup, so the marker is text.
              <option key={agent.id} value={agent.id}>
                {activeAgentIds.has(agent.id) ? `● ${agent.name} (responding)` : agent.name}
              </option>
            ))}
          </select>
        </div>

        <div className="sidebar-section grow">
          <div className="row-between">
            <span className="section-label">Conversations</span>
            <button
              type="button"
              className="link"
              disabled={busy || !agents.agentId}
              onClick={() => void guard(agents.createConversation)}
              aria-label="New conversation"
            >
              <Icon name="plus" /> New
            </button>
          </div>

          <ul className="conversations">
            {/* The default conversation is never listed and cannot be opened
              (see lib/activity.ts), so it can only be reported here. */}
            {activity.inDefault ? (
              <li className="activity-note small muted">
                <span className="activity-dot" aria-hidden="true" />
                Responding in the agent's default conversation (a scheduled or channel turn — not
                listed)
              </li>
            ) : null}
            {activity.unlisted.length > 0 ? (
              <li className="activity-note small muted">
                <span className="activity-dot" aria-hidden="true" />
                Responding in {activity.unlisted.length === 1 ? "a conversation" : "conversations"}{" "}
                not in this list
              </li>
            ) : null}
            {visible.map((conversation) => {
              const archived = conversation.archived;
              const responding = activity.responding.has(conversation.id);
              return (
                <li
                  key={conversation.id}
                  className={conversation.id === agents.conversationId ? "active" : ""}
                >
                  <button
                    type="button"
                    className="conversation-name"
                    onClick={() => {
                      agents.selectConversation(conversation.id);
                      onClose();
                    }}
                  >
                    {responding ? (
                      <span
                        className="activity-dot"
                        role="img"
                        aria-label="Responding"
                        title="Responding…"
                      />
                    ) : null}
                    {conversation.summary}
                    {archived ? <span className="tag muted">archived</span> : null}
                  </button>

                  <div className="conversation-actions">
                    <button
                      type="button"
                      className="link"
                      title="Rename"
                      disabled={busy}
                      onClick={() => {
                        const next = prompt("Conversation name", conversation.summary);
                        if (next && next !== conversation.summary) {
                          void guard(() => agents.renameConversation(conversation.id, next));
                        }
                      }}
                      aria-label={`Rename ${conversation.summary}`}
                    >
                      <Icon name="edit" />
                    </button>
                    <button
                      type="button"
                      className="link"
                      title={archived ? "Unarchive" : "Archive"}
                      disabled={busy}
                      onClick={() =>
                        void guard(() => agents.setArchived(conversation.id, !archived))
                      }
                      aria-label={`${archived ? "Unarchive" : "Archive"} ${conversation.summary}`}
                    >
                      <Icon name={archived ? "unarchive" : "archive"} />
                    </button>
                  </div>
                </li>
              );
            })}
            {visible.length === 0 ? <li className="muted pad">No conversations</li> : null}
          </ul>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            Show archived
          </label>
        </div>

        {agents.error ? <p className="warning small">{agents.error}</p> : null}
      </aside>
    </>
  );
}
