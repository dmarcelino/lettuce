import { useState } from "react";
import { Sheet } from "./Sheet.tsx";

interface Props {
  email: string | undefined;
}

/**
 * Dev-bypass warning, in the header rather than as a fixed banner.
 *
 * It used to be a full-width strip pinned to the bottom of the viewport at
 * z-index 50, which sat on top of the sidebar's controls and every sheet's
 * button row. As a header pill it costs no vertical space and covers nothing.
 */
export function AuthPill({ email }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="pill warn as-button"
        onClick={() => setOpen(true)}
        title="Authentication is disabled"
      >
        ⚠ Unauth
      </button>

      {open ? (
        <Sheet
          title="Unauthenticated (dev bypass)"
          onClose={() => setOpen(false)}
          actions={
            <button type="button" className="button ghost" onClick={() => setOpen(false)}>
              Close
            </button>
          }
        >
          <p className="warning">
            Developer sign-in is enabled. This does <strong>not</strong> authenticate anyone — any
            visitor becomes the configured user. Unset <code>DEV_BYPASS_EMAIL</code> to require
            Google sign-in.
          </p>
          {email ? (
            <p className="muted small">
              Acting as <code>{email}</code>
            </p>
          ) : null}
        </Sheet>
      ) : null}
    </>
  );
}
