import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentActivity } from "../lib/activity.ts";
import { initialOf, tintFor } from "../lib/agent-tint.ts";
import { groupByDate, listDate, visibleConversations } from "../lib/conversation-groups.ts";
import type { AgentsApi, ConversationSummary } from "../state/use-agents.ts";
import { ConversationMenu } from "./ConversationMenu.tsx";
import { Icon } from "./Icon.tsx";
import { toast } from "./Toast.tsx";

interface Props {
  agents: AgentsApi;
  /** Whether the panel is on screen: pinned and on Chat, peeking, or borrowed by a
   * hover. It stays mounted either way — see the note on the component. */
  visible: boolean;
  /** Scope keys of conversations with a response in progress; see `SessionApi.activeScopes`. */
  activeScopes: ReadonlySet<string>;
  /** Whether the panel survives a pane change; the rail has no pin, so this owns it. */
  pinned: boolean;
  onTogglePin: () => void;
  /**
   * Another agent's conversations, borrowed for the moment a pointer rests on their
   * avatar. One panel shows either its own agent's list or a borrowed one — never a
   * second list beside it — and a borrowed one is read-only: its rows switch agent
   * rather than offering archive and rename for someone else's conversation.
   */
  preview: {
    agentId: string;
    name: string;
    conversations: ConversationSummary[];
    loading: boolean;
    failed: boolean;
  } | null;
  onPreviewPick: (agentId: string, conversationId: string) => void;
  /** The pointer is inside the panel, which is what keeps a borrowed list open. */
  onHold: (held: boolean) => void;
}

/**
 * The desktop conversation panel: one agent's conversations, nothing else.
 *
 * The agents left for the rail, so this column is one list instead of two, which
 * is what it needed — the list is the busiest thing on the screen. Whether it is
 * on screen at all is not its call: `pinned` and visibility live in `App`,
 * because the rail's hover and the pane switch both have a say. What it shows can
 * be a borrowed agent's list (`preview`), which is how the rail's hover opens this
 * panel instead of growing a second one beside it.
 */
export function Sidebar({
  agents,
  visible,
  activeScopes,
  pinned,
  onTogglePin,
  preview,
  onPreviewPick,
  onHold,
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

  // Whose list this is: the panel's own agent, or the one the rail is resting on.
  const list = preview ? preview.conversations : agents.conversations;
  const listAgentId = preview?.agentId ?? agents.agentId;
  /** The open conversation only counts while it is the list's own agent. */
  const openId = preview
    ? preview.agentId === agents.agentId
      ? agents.conversationId
      : null
    : agents.conversationId;

  const activity = agentActivity(
    activeScopes,
    listAgentId,
    list.map((conversation) => conversation.id),
  );

  // The switcher's list, laid out for a column: the same filter, search and
  // date sections, so desktop and phone never show two different lists.
  const groups = useMemo(
    () =>
      groupByDate(
        visibleConversations(list, {
          showArchived,
          query,
          responding: activity.responding,
        }),
      ),
    [list, showArchived, query, activity.responding],
  );
  const liveCount = list.filter((c) => !c.archived).length;
  /** The footer link says how much it will reveal, and hides when there is none. */
  const archivedCount = list.filter((c) => c.archived).length;

  // A busy conversation the list has never heard of was created after it was
  // fetched (a cron that starts a new conversation per run). Refetch once per
  // such id; if it still is not there, the notice below says so instead.
  const refetchedFor = useRef(new Set<string>());
  const unlistedKey = activity.unlisted.join(",");
  useEffect(() => {
    if (preview) return;
    const agentId = agents.agentId;
    if (!agentId || !unlistedKey) return;
    const fresh = unlistedKey.split(",").filter((id) => !refetchedFor.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) refetchedFor.current.add(id);
    void agents.refreshConversations(agentId);
  }, [agents.agentId, agents.refreshConversations, unlistedKey, preview]);

  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const closeMenu = useCallback(() => setMenuFor(null), []);

  // The head names whoever the rows belong to: the borrowed agent while a rail hover
  // borrows the panel, otherwise the agent this pane is open on.
  const openAgent = agents.agents.find((agent) => agent.id === agents.agentId);
  const whose = preview
    ? { id: preview.agentId, name: preview.name }
    : (openAgent ?? { id: "", name: "Conversations" });

  return (
    <aside
      className={`sidebar${visible ? "" : " hidden"}`}
      aria-label="Conversations"
      onPointerEnter={() => onHold(true)}
      onPointerLeave={() => onHold(false)}
    >
      <div className="sidebar-section grow">
        <div className="panel-head">
          {/* Whose list this is, named and faced, on the top line — the one place a
              glance lands that says which agent a click will act on. "Conversations"
              would be a lie while borrowed, and mute even when it is yours: the list is
              the agent's, and with names on the rail the head is the only place a
              screenful of chat says who it belongs to. */}
          <span className="panel-who">
            <span
              className="agent-avatar panel-who-face"
              style={{ background: tintFor(whose.id ?? "") }}
            >
              {initialOf(whose.name)}
            </span>
            <span className="section-label agent">{whose.name}</span>
          </span>
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
          {preview ? null : (
            <button
              type="button"
              className="button ghost compact"
              disabled={busy || !agents.agentId}
              onClick={() => void guard(agents.createConversation)}
              aria-label="New conversation"
            >
              <Icon name="plus" /> New
            </button>
          )}
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
          {preview?.loading ? (
            <li className="muted pad">Loading {preview.name}’s conversations…</li>
          ) : null}
          {preview?.failed ? (
            <li className="muted pad">Could not load {preview.name}’s conversations.</li>
          ) : null}
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
                    conversation.id === openId ? "active" : "",
                    menuFor === conversation.id ? "menu-open" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <button
                    type="button"
                    className="conversation-name"
                    onClick={() =>
                      preview
                        ? onPreviewPick(preview.agentId, conversation.id)
                        : agents.selectConversation(conversation.id)
                    }
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

                  {preview ? null : (
                    <>
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
                              archived
                                ? "Unarchived."
                                : "Archived — turn on Show archived to undo.",
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
                    </>
                  )}
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
