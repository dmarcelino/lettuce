import { groupByDate, listDate, visibleConversations } from "../lib/conversation-groups.ts";
import { PANEL_WIDTH, RAIL_WIDTH } from "../lib/rail-size.ts";
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
  /** The panel is open, so the card covers its footprint instead of floating. */
  overPanel: boolean;
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
  overPanel,
}: Props) {
  useBackToClose(onClose);
  const groups = groupByDate(
    visibleConversations(conversations, { showArchived: false, query: "", responding }),
  );
  // Two geometries, because the two cases want different things. With the panel
  // open, the card takes the panel's own footprint: two conversation lists
  // side by side read as a glitch, and the honest question behind the hover is
  // "show me this agent instead" — which is the panel, redrawn. With the panel
  // away, the card is a card: beside the rail (the avatar's own right edge is
  // 17px inside the rail's border, and a card starting there grows out of the
  // middle of the rail), as tall as it needs and no taller than the window.
  const top = Math.min(anchor.top, window.innerHeight - 360);
  const style = overPanel
    ? { left: RAIL_WIDTH, top: 0, width: PANEL_WIDTH }
    : {
        left: Math.max(anchor.right + 6, RAIL_WIDTH + 6),
        top: Math.max(8, top),
      };

  return (
    <div
      className={`flyout${overPanel ? " over-panel" : ""}`}
      style={style}
      role="dialog"
      aria-label={`${agentName} conversations`}
    >
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
