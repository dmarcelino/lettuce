import { useState } from "react";
import { Icon } from "./Icon.tsx";
import { Sheet } from "./Sheet.tsx";

interface Props {
  email: string | undefined;
}

/**
 * The warning that nobody actually signed in, in the header rather than as a
 * fixed banner.
 *
 * It used to be a full-width strip pinned to the bottom of the viewport at
 * z-index 50, which sat on top of the sidebar's controls and every sheet's
 * button row. As a header pill it costs no vertical space and covers nothing.
 *
 * It shows for `SIGNIN=none` only — the one method where the session is a
 * formality and any visitor is the owner. Under a password, Access, or Google
 * the session means something and there is nothing to warn about.
 */
export function AuthPill({ email }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* The icon is the warning at every width; on a desktop browser the top bar
          has room to name it, so the triangle is not a mystery glyph. */}
      <span className="topbar-status">
        <button
          type="button"
          className="auth-warning"
          onClick={() => setOpen(true)}
          title="Sign-in is disabled"
          aria-label="Sign-in is disabled"
        >
          <Icon name="warning" />
        </button>
        <span className="topbar-word">No sign-in</span>
      </span>

      {open ? (
        <Sheet title="Sign-in is disabled" size="compact" onClose={() => setOpen(false)}>
          <p className="warning">
            This instance signs nobody in: anyone who can reach its address is the owner. Boot only
            allows it while the port listens on this machine, so the exposure is whoever can use
            this computer.
          </p>
          <p className="muted small">
            Set <code>SIGNIN=password</code> in <code>docker/.env</code> to change that — the port
            may then open to your network, and Settings shows where it is bound.
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
