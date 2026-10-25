import { useEffect, useRef } from "react";
import { BackStack, type Close } from "../lib/back-stack.ts";

// Created on first use, inside an effect: importing this module must not touch
// `window` (unit tests import components that use it, with no browser).
let stack: BackStack | null = null;
function backStack(): BackStack {
  if (!stack) {
    const created = new BackStack(window.history);
    window.addEventListener("popstate", () => created.onPopState());
    stack = created;
  }
  return stack;
}

/**
 * Make the phone's Back button close this overlay instead of the app, while
 * `active`. `onClose` returning `false` marks it undismissable: Back is
 * swallowed rather than closing it or leaving the app. See `lib/back-stack.ts`.
 *
 * `rank` orders overlays open at the same time — `Sheet` passes the document
 * depth of its element, so a sheet stacked over another owns Back. Evaluated
 * when the effect runs, after the DOM node exists.
 */
export function useBackToClose(onClose: Close, active = true, rank: () => number = () => 0): void {
  const latest = useRef(onClose);
  latest.current = onClose;
  const latestRank = useRef(rank);
  latestRank.current = rank;
  useEffect(() => {
    if (!active) return;
    return backStack().open(() => latest.current(), latestRank.current());
  }, [active]);
}
