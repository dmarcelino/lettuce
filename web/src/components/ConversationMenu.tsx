import type { AgentsApi, ConversationSummary } from "../state/use-agents.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  agents: AgentsApi;
  conversation: ConversationSummary;
  busy: boolean;
  /** Runs an action with the list's busy flag held. */
  guard: (action: () => Promise<void>) => Promise<void>;
  onClose: () => void;
}

/**
 * A conversation's ⋯ menu: Rename and Archive. One component for the phone
 * switcher and the desktop sidebar, so the two lists offer the same actions.
 * The caller positions it (`.switcher-menu` is absolute) and decides what
 * closes it besides picking an item.
 */
export function ConversationMenu({ agents, conversation, busy, guard, onClose }: Props) {
  return (
    <div className="switcher-menu" role="menu">
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        onClick={() => {
          onClose();
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
          onClose();
          void guard(() => agents.setArchived(conversation.id, !conversation.archived));
        }}
      >
        <Icon name={conversation.archived ? "unarchive" : "archive"} />{" "}
        {conversation.archived ? "Unarchive" : "Archive"}
      </button>
    </div>
  );
}
