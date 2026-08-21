import { useState } from "react";
import type { AgentsApi } from "../state/use-agents.ts";

interface Props {
  agents: AgentsApi;
  open: boolean;
  onClose: () => void;
  onNewAgent: () => void;
  onEditAgent: (agentId: string) => void;
}

export function Sidebar({ agents, open, onClose, onNewAgent, onEditAgent }: Props) {
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);

  const visible = agents.conversations.filter(
    (conversation) => showArchived || !conversation.archived,
  );

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
              >
                ✎
              </button>
              <button type="button" className="link" disabled={busy} onClick={onNewAgent}>
                + New
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
              <option key={agent.id} value={agent.id}>
                {agent.name}
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
            >
              + New
            </button>
          </div>

          <ul className="conversations">
            {visible.map((conversation) => {
              const archived = conversation.archived;
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
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="link"
                      title={archived ? "Unarchive" : "Archive"}
                      disabled={busy}
                      onClick={() =>
                        void guard(() => agents.setArchived(conversation.id, !archived))
                      }
                    >
                      {archived ? "↩" : "🗄"}
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
