import { groupByDate, listDate, visibleConversations } from "../lib/conversation-groups.ts";
import type { ConversationSummary } from "../state/use-agents.ts";
import { useBackToClose } from "../state/use-back-to-close.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  agentName: string;
  /** The avatar it hangs from, in viewport coordinates. */
  anchor: DOMRect;
  /** Anything with the three fields the switcher's cards draw. */
  conversations: readonly ConversationSummary[];
  responding: ReadonlySet<string>;
  loading: boolean;
  failed: boolean;
  /** The conversation open right now, when the card is for the selected agent. */
  conversationId: string | null;
  /** How many of this agent's conversations are responding (header line). */
  respondingCount: number;
  onPick: (conversationId: string) => void;
  onNewConversation: () => void;
  /** "Search all…": the full-screen switcher, which can search this agent's list. */
  onSearchAll: () => void;
  onClose: () => void;
}

/**
 * The rail's hover card: one agent's recent conversations, opened by resting on
 * its avatar while the conversation panel is hidden.
 *
 * Fixed to the viewport like `AgentMenu` for the same reason — the rail scrolls,
 * and an absolutely positioned card would be clipped by it. Every verb here is
 * also reachable without a hover (tapping the avatar opens the panel), because
 * touch has no hover to rest on: this is a shortcut, not the only way in.
 */
export function ConversationFlyout({
  agentName,
  anchor,
  conversations,
  responding,
  loading,
  failed,
  conversationId,
  respondingCount,
  onPick,
  onNewConversation,
  onSearchAll,
  onClose,
}: Props) {
  useBackToClose(onClose);
  const groups = groupByDate(
    visibleConversations(conversations, { showArchived: false, query: "", responding }),
  );
  // The avatar is 34px inside a 74px rail; the card opens beside the avatar and
  // stays inside the viewport's bottom edge, which a tall list would otherwise
  // run past.
  const top = Math.min(anchor.top, window.innerHeight - 360);
  const style = { left: anchor.right + 6, top: Math.max(8, top) };

  return (
    <div className="flyout" style={style} role="dialog" aria-label={`${agentName} conversations`}>
      <div className="flyout-head">
        <strong>{agentName}</strong>
        {respondingCount > 0 ? (
          <span className="responding small">{respondingCount} responding</span>
        ) : null}
      </div>
      <div className="flyout-list">
        {groups.map((group) => (
          <section key={group.label}>
            <h3 className="switcher-group">{group.label}</h3>
            {group.items.map((conversation) => (
              <div
                key={conversation.id}
                className={`switcher-card conversation${
                  conversation.id === conversationId ? " selected" : ""
                }`}
              >
                <button
                  type="button"
                  className="switcher-card-main"
                  onClick={() => onPick(conversation.id)}
                >
                  <span className="switcher-card-title">{conversation.summary}</span>
                  <span className="switcher-card-meta">
                    {listDate(conversation.updatedAt)}
                    {responding.has(conversation.id) ? (
                      <span className="responding"> · responding…</span>
                    ) : null}
                  </span>
                </button>
              </div>
            ))}
          </section>
        ))}
        {loading ? <p className="muted small switcher-empty">Loading…</p> : null}
        {failed ? (
          <p className="muted small switcher-empty">Could not load conversations.</p>
        ) : null}
        {!loading && !failed && groups.length === 0 ? (
          <p className="muted small switcher-empty">No conversations yet.</p>
        ) : null}
      </div>
      <div className="flyout-foot">
        <button type="button" className="link" onClick={onSearchAll}>
          <Icon name="search" /> Search all…
        </button>
        <button type="button" className="link" onClick={onNewConversation}>
          <Icon name="plus" /> New conversation
        </button>
      </div>
    </div>
  );
}
