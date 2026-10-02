import { useEffect } from "react";
import { useBackToClose } from "../state/use-back-to-close.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  src: string;
  alt: string;
  onClose: () => void;
}

/**
 * Full-size in-app preview of one transcript image.
 *
 * Deliberately not an anchor to the image's `data:` URL: browsers refuse
 * top-level navigation to `data:` from a click, so "open in a new tab" was
 * always a dead tab. The image already rides in the transcript entry, so the
 * preview needs no fetch and no object-URL lifecycle.
 */
export function ImageLightbox({ src, alt, onClose }: Props) {
  // The phone's Back closes the preview, not the app — same rule as sheets.
  useBackToClose(onClose);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt}>
      {/* A real button for the backdrop, like the sheet scrim: keyboard-
          reachable dismissal rather than a click handler on a div. */}
      <button type="button" className="sheet-scrim" aria-label="Close" onClick={onClose} />
      {/* Tapping the image itself closes too (the gesture everyone tries on a
          phone), and a button keeps that reachable without a bare click
          handler on the img. */}
      <button type="button" className="lightbox-img-wrap" onClick={onClose} aria-label="Close">
        <img className="lightbox-img" src={src} alt={alt} />
      </button>
      <button type="button" className="lightbox-close" onClick={onClose} aria-label="Close">
        <Icon name="close" />
      </button>
    </div>
  );
}
