import { type ReactNode, useEffect } from "react";
import { useBackToClose } from "../state/use-back-to-close.ts";

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
   * Resize floor, on desktop only (see `size` in styles.css): "compact" for a
   * notice or a 1-3 field form, "spacious" for a document (usually paired with
   * `fill`) or something as open-ended as a diff review. Omitted means
   * "standard" — a picker list or an ordinary form — which is most callers.
   */
  size?: "compact" | "spacious";
  actions: ReactNode;
  children: ReactNode;
}

/**
 * Dismissible sheet shell: a bottom sheet on a phone, a centred modal on a
 * desktop browser (see the `min-width: 900px` block in styles.css).
 *
 * Not used by ApprovalSheet, which is deliberately undismissable — an approval
 * has to be answered, not escaped.
 */
export function Sheet({ title, onClose, status, fill = false, size, actions, children }: Props) {
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
        <div className="sheet-body">
          <h2>{title}</h2>
          {children}
        </div>
        {status ? <p className="sheet-status">{status}</p> : null}
        <div className="sheet-actions">{actions}</div>
      </div>
    </div>
  );
}
