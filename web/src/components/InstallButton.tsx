import { useEffect, useState } from "react";
import { Icon } from "./Icon.tsx";
import { Sheet } from "./Sheet.tsx";

/** `beforeinstallprompt` is not in lib.dom yet. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function runningStandalone(): boolean {
  try {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

/**
 * "Install" pill in the header.
 *
 * Chromium fires `beforeinstallprompt` once the app is installable (valid
 * manifest + a registered service worker + a secure context); we keep the event
 * and fire the native prompt on click. iOS Safari has no such event and no
 * programmatic install, so there the button just toggles the Share-sheet hint.
 *
 * Renders nothing when already running standalone, or when neither path applies
 * — already installed, an unsupported browser, or served without a secure
 * context so the service worker never registered (the LAN HTTP origin). It only
 * appears when the app can actually be installed.
 */
export function InstallButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(runningStandalone);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      // Keep it from surfacing Chrome's own mini-infobar; we place the control.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return null;
  const iosFallback = isIOS && !deferred;
  if (!deferred && !iosFallback) return null;

  const onClick = () => {
    if (!deferred) {
      setShowHelp(true);
      return;
    }
    void (async () => {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === "accepted") setInstalled(true);
      setDeferred(null);
    })();
  };

  return (
    <>
      <button
        type="button"
        className="pill as-button"
        onClick={onClick}
        title="Install this app"
        aria-label="Install this app"
      >
        <Icon name="download" /> Install
      </button>

      {showHelp ? (
        <Sheet
          title="Add to Home Screen"
          size="compact"
          onClose={() => setShowHelp(false)}
          actions={
            <button type="button" className="button ghost" onClick={() => setShowHelp(false)}>
              Close
            </button>
          }
        >
          <p className="muted">
            In Safari, tap the <strong>Share</strong> button, then{" "}
            <strong>Add to Home Screen</strong>. The app then opens full-screen, and web-push
            notifications work.
          </p>
        </Sheet>
      ) : null}
    </>
  );
}
