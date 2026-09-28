import { Icon } from "./Icon.tsx";

interface Props {
  agentName: string;
  pinned: boolean;
  /** The ⋯ button it belongs to: the menu opens above it. */
  anchor: DOMRect;
  onEdit: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
  onClose: () => void;
}

/**
 * An agent's ⋯ menu in the switcher: Edit, Pin / Unpin, Delete. Fixed to the
 * viewport rather than absolute like `ConversationMenu`: the agents sit in
 * their own scrolling box at the bottom of the screen, which would clip a
 * menu positioned inside it — so it opens upward from the button instead.
 */
export function AgentMenu({
  agentName,
  pinned,
  anchor,
  onEdit,
  onTogglePin,
  onDelete,
  onClose,
}: Props) {
  const pick = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <div
      className="switcher-menu floating"
      role="menu"
      aria-label={`Actions for ${agentName}`}
      style={{
        right: Math.max(8, window.innerWidth - anchor.right),
        bottom: Math.max(8, window.innerHeight - anchor.top + 4),
      }}
    >
      <button type="button" role="menuitem" onClick={pick(onEdit)}>
        <Icon name="edit" /> Edit
      </button>
      <button type="button" role="menuitem" onClick={pick(onTogglePin)}>
        <Icon name="pin" /> {pinned ? "Unpin" : "Pin to top"}
      </button>
      <button type="button" role="menuitem" className="danger" onClick={pick(onDelete)}>
        <Icon name="trash" /> Delete…
      </button>
    </div>
  );
}
