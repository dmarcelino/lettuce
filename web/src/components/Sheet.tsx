import { type ReactNode, useEffect } from "react";
import { useBackToClose } from "../state/use-back-to-close.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  title: string;
  onClose: () => void;
  /** Sticky line above the actions. Never scrolls out of view like body text can. */
  status?: string | null;
  /**
   * The body is ONE document to read or edit — a memory block, a file — rather
   * than a form or a list. Every sheet is the same width; this only changes
   * whether the content fills the panel's height, so it scrolls once in the
   * element that holds it instead of a small pane scrolling inside a scrolling
   * sheet. No effect on a phone, where sheets are full-width already.
   */
  fill?: boolean;
  /**
   * Width tier, on desktop only (see `.sheet-panel` in styles.css): "compact"
   * (480px) for a notice or a 1-3 field form, "spacious" (880px, the content
   * column) for a document (usually paired with `fill`) or something as
   * open-ended as a diff review. Omitted means "standard" (560px) — a menu or
   * an ordinary form — which is most callers.
   */
  size?: "compact" | "spacious";
  /**
   * The bottom button row, for a FORM (Save / Cancel). Omit it for a MENU —
   * a list you pick from, where choices apply at once — or a notice: those
   * have no footer. Every sheet has the same header either way: the title,
   * `headerAction` and a ✕. See `MenuRow` for menu rows.
   */
  actions?: ReactNode;
  /** A menu's own extra action, beside the ✕ ("Show all", refresh). */
  headerAction?: ReactNode;
  children: ReactNode;
}

/**
 * Dismissible sheet shell: a bottom sheet on a phone, a centred modal on a
 * desktop browser (see the `min-width: 900px` block in styles.css).
 *
 * Not used by ApprovalSheet, which is deliberately undismissable — an approval
 * has to be answered, not escaped.
 */
export function Sheet({
  title,
  onClose,
  status,
  fill = false,
  size,
  actions,
  headerAction,
  children,
}: Props) {
  // The phone's Back closes this sheet, not the app — every sheet in the app
  // goes through here.
  useBackToClose(onClose);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="sheet">
      {/* A real button, like the sidebar's scrim: clicking outside dismisses,
          and the control is reachable from the keyboard rather than being a
          click handler bolted onto a presentational div. */}
      <button type="button" className="sheet-scrim" aria-label="Close" onClick={onClose} />
      <div
        className={`sheet-panel${fill ? " fill" : ""}${size ? ` sheet-${size}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="sheet-head">
          <h2>{title}</h2>
          {headerAction}
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {status ? <p className="sheet-status">{status}</p> : null}
        {actions === undefined ? null : <div className="sheet-actions">{actions}</div>}
      </div>
    </div>
  );
}
