import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentActivity } from "../lib/activity.ts";
import { groupByDate, listDate, visibleConversations } from "../lib/conversation-groups.ts";
import type { AgentsApi } from "../state/use-agents.ts";
import { ConversationMenu } from "./ConversationMenu.tsx";
import { Icon } from "./Icon.tsx";
import { toast } from "./Toast.tsx";

interface Props {
  agents: AgentsApi;
  /** Whether the panel is on screen: pinned and on Chat, or peeking. It stays
   * mounted either way — see the note on the component. */
  visible: boolean;
  /** Scope keys of conversations with a response in progress; see `SessionApi.activeScopes`. */
  activeScopes: ReadonlySet<string>;
  /** Whether the panel survives a pane change; the rail has no pin, so this owns it. */
  pinned: boolean;
  onTogglePin: () => void;
}

/**
 * The desktop conversation panel: the open agent's conversations, nothing else.
 *
 * The agents left for the rail, so this column is one list instead of two, which
 * is what it needed — the list is the busiest thing on the screen. Whether it is
 * on screen at all is not its call: `pinned` and visibility live in `App`,
 * because the rail, the hover card and the pane switch all have a say.
 */
export function Sidebar({ agents, visible, activeScopes, pinned, onTogglePin }: Props) {
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
  /** The footer link says how much it will reveal, and hides when there is none. */
  const archivedCount = agents.conversations.filter((c) => c.archived).length;

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
  }, [agents.agentId, unlistedKey, agents.refreshConversations]);

  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const closeMenu = useCallback(() => setMenuFor(null), []);

  return (
    <aside className={`sidebar${visible ? "" : " hidden"}`} aria-label="Conversations">
      <div className="sidebar-section grow">
        <div className="panel-head">
          <span className="section-label">Conversations</span>
          <button
            type="button"
            className={`icon-button flat panel-pin${pinned ? " on" : ""}`}
            onClick={onTogglePin}
            aria-pressed={pinned}
            title={
              pinned
                ? "Keeping the panel open on Chat — click to make it a peek"
                : "Peek only — click to keep the panel open on Chat"
            }
            aria-label={pinned ? "Unpin the conversation panel" : "Pin the conversation panel"}
          >
            <Icon name="pin" />
          </button>
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
                  data-conversation-id={conversation.id}
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
                    onClick={() => agents.selectConversation(conversation.id)}
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
                    className="icon-button flat conversation-archive"
                    aria-label={`${archived ? "Unarchive" : "Archive"} “${conversation.summary}”`}
                    title={archived ? "Unarchive" : "Archive"}
                    disabled={busy}
                    onClick={() =>
                      void guard(async () => {
                        // One click, no sheet: the undo is one more click, and
                        // the row's more menu has offered this verb without a
                        // confirmation since it existed.
                        await agents.setArchived(conversation.id, !archived);
                        toast(
                          archived ? "Unarchived." : "Archived — turn on Show archived to undo.",
                        );
                      })
                    }
                  >
                    <Icon name={archived ? "unarchive" : "archive"} />
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
                      onClose={closeMenu}
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

        {archivedCount > 0 ? (
          <button
            type="button"
            className="link sidebar-archived"
            onClick={() => setShowArchived((value) => !value)}
          >
            {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
          </button>
        ) : null}
      </div>

      {agents.error ? (
        <p className="warning small" role="alert">
          <span>{agents.error}</span>
          <button type="button" className="link" onClick={() => void agents.refreshAgents()}>
            Try again
          </button>
        </p>
      ) : null}
    </aside>
  );
}
