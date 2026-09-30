import { useEffect, useRef, useState } from "react";

/**
 * Press-vs-hold on one button: a short press does one thing, holding past the
 * threshold does another. The composer's send button uses it to be both
 * "queue this message" (press) and "stop the agent" (hold) while a turn runs.
 *
 * The timing lives in a plain controller so it can be tested without React;
 * the hook only wires it to state and cleans the timer up on unmount.
 */

const DEFAULT_MS = 500;
const DEFAULT_CLICK_WINDOW_MS = 600;

export interface LongPressController {
  pointerDown(): void;
  pointerUp(): void;
  pointerCancel(): void;
  /**
   * The click that follows a pointer release (or a keyboard Enter/Space on a
   * focused button). Ignored when a pointer gesture already acted, so a press
   * never fires twice; a keyboard click still performs the short action.
   */
  click(): void;
  /**
   * Claim the trailing click of the most recent pointer gesture, from a
   * handler other than `click()` — the one now mounted on the same button
   * after the branch swapped. The composer's button changes branch, and with
   * it its click handler, inside the pointerup action itself (queueing
   * empties the box, so the button becomes the stop button), and React
   * re-renders before the click dispatches — so the click lands on the
   * *next* action's handler, which must be able to ask "was this my click, or
   * the previous gesture's?". True once per gesture; a stale gesture (no
   * click ever arrived, e.g. the button went disabled) does not swallow a
   * later genuine click.
   */
  consumeGesture(): boolean;
  /** True when a hold is in progress and the context menu must be suppressed. */
  contextMenu(): boolean;
  dispose(): void;
}

export function createLongPress(options: {
  enabled(): boolean;
  onShort(): void;
  onLong(): void;
  ms?: number;
  /** How long a gesture's trailing click may arrive and still be claimed. */
  clickWindowMs?: number;
  onHeldChange?(held: boolean): void;
}): LongPressController {
  const ms = options.ms ?? DEFAULT_MS;
  const clickWindow = options.clickWindowMs ?? DEFAULT_CLICK_WINDOW_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  /** Timestamp of the last pointerdown, until its trailing click claims it. */
  let gestureAt: number | null = null;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const consumeGesture = () => {
    if (gestureAt === null) return false;
    const fresh = Date.now() - gestureAt < clickWindow;
    gestureAt = null;
    return fresh;
  };

  return {
    pointerDown() {
      if (!options.enabled()) return;
      fired = false;
      gestureAt = Date.now();
      options.onHeldChange?.(true);
      timer = setTimeout(() => {
        timer = null;
        fired = true;
        options.onHeldChange?.(false);
        options.onLong();
      }, ms);
    },
    pointerUp() {
      // The trailing click follows the release by milliseconds, whatever the
      // hold lasted — so the claim window is measured from here, not from
      // pointerdown. A hold longer than the window must still swallow its
      // click, or a long press would also perform the short action.
      if (gestureAt !== null) gestureAt = Date.now();
      if (timer === null) {
        // Either never enabled, or the long action already fired — release
        // after a fired hold does nothing. The gesture stays claimable: the
        // trailing click still has to be swallowed, by whoever is mounted
        // when it lands.
        return;
      }
      clear();
      options.onHeldChange?.(false);
      if (!fired) options.onShort();
    },
    pointerCancel() {
      clear();
      options.onHeldChange?.(false);
      // No click follows a cancelled gesture; do not leave one swallowed.
      gestureAt = null;
    },
    click() {
      if (consumeGesture()) return;
      if (!options.enabled()) return;
      options.onShort();
    },
    consumeGesture,
    contextMenu() {
      return timer !== null;
    },
    dispose() {
      clear();
    },
  };
}

export interface LongPressHandlers {
  onPointerDown: () => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onClick: () => void;
  onContextMenu: (event: { preventDefault(): void }) => void;
  /** See `LongPressController.consumeGesture`. */
  consumeGesture: () => boolean;
  /** True while a hold is counting down — for a pressed visual state. */
  held: boolean;
}

export function useLongPress(options: {
  enabled: boolean;
  onShort: () => void;
  onLong: () => void;
  ms?: number;
}): LongPressHandlers {
  const [held, setHeld] = useState(false);
  // Latest callbacks/flag without re-creating the controller each render.
  const liveRef = useRef(options);
  liveRef.current = options;

  const controllerRef = useRef<LongPressController | null>(null);
  controllerRef.current ??= createLongPress({
    enabled: () => liveRef.current.enabled,
    onShort: () => liveRef.current.onShort(),
    onLong: () => liveRef.current.onLong(),
    ms: options.ms,
    onHeldChange: setHeld,
  });

  useEffect(() => () => controllerRef.current?.dispose(), []);

  const controller = controllerRef.current;
  return {
    onPointerDown: () => controller.pointerDown(),
    onPointerUp: () => controller.pointerUp(),
    onPointerCancel: () => controller.pointerCancel(),
    onClick: () => controller.click(),
    onContextMenu: (event) => {
      if (controller.contextMenu()) event.preventDefault();
    },
    consumeGesture: () => controller.consumeGesture(),
    held,
  };
}
