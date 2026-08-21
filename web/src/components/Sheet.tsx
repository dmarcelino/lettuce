import { type ReactNode, useEffect } from "react";

interface Props {
  title: string;
  onClose: () => void;
  /** Sticky line above the actions. Never scrolls out of view like body text can. */
  status?: string | null;
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
export function Sheet({ title, onClose, status, actions, children }: Props) {
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
      <div className="sheet-panel" role="dialog" aria-modal="true" aria-label={title}>
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
