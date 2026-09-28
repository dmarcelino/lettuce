import { useEffect } from "react";
import { useBackToClose } from "../state/use-back-to-close.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  agentName: string;
  pinned: boolean;
  archived: boolean;
  /** The ⋯ button it belongs to (marked `data-agent-more`). */
  anchor: DOMRect;
  /**
   * "above" in the phone switcher, whose agents sit at the bottom of the
   * screen; "below" in the desktop sidebar, where the button is at the top.
   */
  placement: "above" | "below";
  onEdit: () => void;
  onTogglePin: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
  onClose: () => void;
}

/**
 * An agent's ⋯ menu: Edit, Pin / Unpin, Archive / Unarchive, Delete. One
 * component for the phone switcher and the desktop sidebar. Fixed to the
 * viewport rather than absolute like `ConversationMenu`: the switcher's agents
 * sit in their own scrolling box, which would clip a menu positioned inside
 * it. So it closes itself on a press anywhere else and on Back — a fixed menu
 * left open would float away from its row when the list scrolls (the caller
 * closes it on scroll).
 */
export function AgentMenu({
  agentName,
  pinned,
  archived,
  anchor,
  placement,
  onEdit,
  onTogglePin,
  onToggleArchive,
  onDelete,
  onClose,
}: Props) {
  useBackToClose(onClose);
  useEffect(() => {
    // Presses on a ⋯ button are left to its click, which toggles.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".agent-menu, [data-agent-more]")) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const pick = (action: () => void) => () => {
    onClose();
    action();
  };
  const position =
    placement === "above"
      ? {
          right: Math.max(8, window.innerWidth - anchor.right),
          bottom: Math.max(8, window.innerHeight - anchor.top + 4),
        }
      : { left: Math.max(8, anchor.left), top: anchor.bottom + 4 };

  return (
    <div
      className="switcher-menu floating agent-menu"
      role="menu"
      aria-label={`Actions for ${agentName}`}
      style={position}
    >
      <button type="button" role="menuitem" onClick={pick(onEdit)}>
        <Icon name="edit" /> Edit
      </button>
      {/* An archived agent is hidden from the lists, so pinning it to their
          top means nothing; unarchive first. */}
      {archived ? null : (
        <button type="button" role="menuitem" onClick={pick(onTogglePin)}>
          <Icon name="pin" /> {pinned ? "Unpin" : "Pin to top"}
        </button>
      )}
      <button type="button" role="menuitem" onClick={pick(onToggleArchive)}>
        <Icon name={archived ? "unarchive" : "archive"} /> {archived ? "Unarchive" : "Archive"}
      </button>
      <button type="button" role="menuitem" className="danger" onClick={pick(onDelete)}>
        <Icon name="trash" /> Delete…
      </button>
    </div>
  );
}
