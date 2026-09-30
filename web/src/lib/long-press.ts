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
  /** True when a hold is in progress and the context menu must be suppressed. */
  contextMenu(): boolean;
  dispose(): void;
}

export function createLongPress(options: {
  enabled(): boolean;
  onShort(): void;
  onLong(): void;
  ms?: number;
  onHeldChange?(held: boolean): void;
}): LongPressController {
  const ms = options.ms ?? DEFAULT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  let gesture = false;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    pointerDown() {
      if (!options.enabled()) return;
      fired = false;
      gesture = true;
      options.onHeldChange?.(true);
      timer = setTimeout(() => {
        timer = null;
        fired = true;
        options.onHeldChange?.(false);
        options.onLong();
      }, ms);
    },
    pointerUp() {
      if (timer === null) {
        // Either never enabled, or the long action already fired — release
        // after a fired hold does nothing.
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
      gesture = false;
    },
    click() {
      if (gesture) {
        gesture = false;
        return;
      }
      if (!options.enabled()) return;
      options.onShort();
    },
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
    held,
  };
}
