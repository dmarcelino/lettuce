import { useEffect, useMemo, useRef, useState } from "react";
import { agentActivity } from "../lib/activity.ts";
import { groupByDate, listDate, visibleConversations } from "../lib/conversation-groups.ts";
import type { AgentsApi } from "../state/use-agents.ts";
import { ConversationMenu } from "./ConversationMenu.tsx";
import { Icon } from "./Icon.tsx";
import { ToggleRow } from "./MenuRow.tsx";

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
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // An open ⋯ menu closes on Escape or a press anywhere outside it (its own
  // button toggles it), and scrolls into view: the list clips it otherwise.
  useEffect(() => {
    if (!menuFor) return;
    const row = listRef.current?.querySelector<HTMLElement>("li.menu-open");
    row?.querySelector(".switcher-menu")?.scrollIntoView({ block: "nearest" });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuFor(null);
    };
    const onPointer = (event: PointerEvent) => {
      if (!row?.contains(event.target as Node)) setMenuFor(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [menuFor]);

  const activity = agentActivity(
    activeScopes,
    agents.agentId,
    agents.conversations.map((conversation) => conversation.id),
  );

  // The switcher's list, laid out for a column: the same filter, search and
  // date sections, so desktop and phone never show two different lists.
  const groups = useMemo(
    () =>
      groupByDate(
        visibleConversations(agents.conversations, {
          showArchived,
          query,
          responding: activity.responding,
        }),
      ),
    [agents.conversations, showArchived, query, activity.responding],
  );
  const liveCount = agents.conversations.filter((c) => !c.archived).length;

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
                className="button ghost compact square"
                title="Edit agent"
                disabled={busy || !agents.agentId}
                onClick={() => agents.agentId && onEditAgent(agents.agentId)}
                aria-label="Edit agent"
              >
                <Icon name="edit" />
              </button>
              <button
                type="button"
                className="button ghost compact"
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
            {(() => {
              // A native option cannot hold markup, so the marker is text — and
              // words rather than a dot glyph, which the UI does not use.
              const option = (agent: (typeof agents.agents)[number]) => (
                <option key={agent.id} value={agent.id}>
                  {activeAgentIds.has(agent.id) ? `${agent.name} — responding` : agent.name}
                </option>
              );
              // Pinned agents lead the list already; with any pinned, the two
              // groups are labelled, since an option cannot carry the pin icon.
              const pinned = agents.agents.filter((agent) => agents.pinned.has(agent.id));
              if (pinned.length === 0) return agents.agents.map(option);
              return (
                <>
                  <optgroup label="Pinned">{pinned.map(option)}</optgroup>
                  <optgroup label="Agents">
                    {agents.agents.filter((agent) => !agents.pinned.has(agent.id)).map(option)}
                  </optgroup>
                </>
              );
            })()}
          </select>
        </div>

        <div className="sidebar-section grow">
          <div className="row-between">
            <span className="section-label">Conversations</span>
            <button
              type="button"
              className="button ghost compact"
              disabled={busy || !agents.agentId}
              onClick={() => void guard(agents.createConversation)}
              aria-label="New conversation"
            >
              <Icon name="plus" /> New
            </button>
          </div>

          <label className="switcher-search sidebar-search">
            <Icon name="search" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${liveCount} conversations`}
              aria-label="Search conversations"
            />
          </label>

          <ul className="conversations" ref={listRef}>
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
            {groups.flatMap((group) => [
              <li key={`group:${group.label}`} className="conversation-group">
                {group.label}
              </li>,
              ...group.items.map((conversation) => {
                const archived = conversation.archived;
                const responding = activity.responding.has(conversation.id);
                return (
                  <li
                    key={conversation.id}
                    className={[
                      "conversation-row",
                      conversation.id === agents.conversationId ? "active" : "",
                      menuFor === conversation.id ? "menu-open" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
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
                      <span className="conversation-title">{conversation.summary}</span>
                      {archived ? <span className="tag muted">archived</span> : null}
                      <span className="conversation-date muted small">
                        {listDate(conversation.updatedAt)}
                      </span>
                    </button>

                    <button
                      type="button"
                      className="icon-button flat conversation-more"
                      aria-label={`More for ${conversation.summary}`}
                      aria-haspopup="menu"
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
                      <ConversationMenu
                        agents={agents}
                        conversation={conversation}
                        busy={busy}
                        guard={guard}
                        onClose={() => setMenuFor(null)}
                      />
                    ) : null}
                  </li>
                );
              }),
            ])}
            {groups.length === 0 ? (
              <li className="muted pad">
                {query.trim() ? "No conversation matches." : "No conversations"}
              </li>
            ) : null}
          </ul>

          <ToggleRow title="Show archived" checked={showArchived} onChange={setShowArchived} />
        </div>

        {agents.error ? <p className="warning small">{agents.error}</p> : null}
      </aside>
    </>
  );
}
