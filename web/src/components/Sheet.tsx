import { type ReactNode, useEffect, useRef } from "react";
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

/** How many elements sit above this one — the nesting depth of a sheet. */
function nodeDepth(node: Element | null): number {
  let depth = 0;
  for (let el = node?.parentElement ?? null; el; el = el.parentElement) depth += 1;
  return depth;
}

/**
 * The innermost open sheet — the deepest `.sheet` in the document, later ones
 * winning a tie at the same depth.
 *
 * A sheet rendered inside another sheet (a model picker over the agent editor) is
 * a descendant of the outer one, so document order and depth both say which is on
 * top. That is what Back and Escape belong to; the registration order alone would
 * say the outer one, and closing the editor under a picker drops its draft.
 */
function topSheet(): Element | null {
  let top: Element | null = null;
  for (const sheet of document.querySelectorAll(".sheet")) {
    if (!top || nodeDepth(sheet) >= nodeDepth(top)) top = sheet;
  }
  return top;
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
  // goes through here. The rank is its depth in the document, so a sheet stacked
  // over another owns Back while it is open.
  const rootRef = useRef<HTMLDivElement>(null);
  useBackToClose(onClose, true, () => nodeDepth(rootRef.current));
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape belongs to the innermost sheet only. A bare document listener let
      // one press close every sheet stacked under it.
      if (topSheet() !== rootRef.current) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="sheet" ref={rootRef}>
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
