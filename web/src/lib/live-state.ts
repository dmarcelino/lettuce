/**
 * The live-state rules of a conversation, kept apart from the React that holds
 * the state they decide.
 *
 * What the transcript looks like lives in `lib/messages.ts`: pure, tested. What
 * stayed inside `use-conversation` were three small decisions about the
 * live-only state the app-server stores nowhere — whether a status frame may move
 * the working indicator, whether it survives a turn boundary, and when the stall
 * watchdog is due to ask the app-server what it believes. One of the three was
 * written twice and held together by a comment, which is the whole argument for
 * pulling them out: these are the rules a lost or reordered frame trips over, and
 * none of them needs a DOM to test.
 */

/** How long past the stall warning the probe waits before asking (see `stallProbeDue`). */
export const STALL_PROBE_GRACE_MS = 15_000;

/**
 * The force-send seam. Esc aborts a turn and its replacement is sent behind the
 * abort, and through that gap the app-server's own frames say "not processing"
 * while the replacement's start frames can arrive before the aborted turn's
 * `turn_finished`. So while the seam is open only a frame that says *busy* may
 * move the indicator, and the seam closes at `turn_finished` and nowhere else.
 *
 * Two frame kinds carry the seam (`update_device_status`, `update_loop_status`),
 * which is why the rule is one function: two copies agreed only because a
 * comment pointed from one to the other.
 */
export function seamAllowsFlip(expectResentTurn: boolean, busy: boolean): boolean {
  return !expectResentTurn || busy;
}

/**
 * Whether the working indicator survives one turn's end. A ready queued item
 * means the pump starts the next turn the moment this one unwinds, so the dots
 * must not blink off in between; items parked by an interrupt are paused and
 * will not start, so they do not hold it on.
 */
export function indicatorStaysOn(queue: readonly { paused: boolean }[]): boolean {
  return queue.some((item) => !item.paused);
}

/**
 * Whether the stall watchdog asks the app-server for its opinion right now.
 *
 * Once per turn (the caller clears `probed` when `processing` goes false), never
 * while an abort is in flight, and only after the warning would already be
 * showing — a client-side stranding then self-heals seconds after the warning
 * would appear, while a genuinely hung turn is reported truthfully and keeps it.
 */
export function stallProbeDue(input: {
  probed: boolean;
  stopping: boolean;
  lastActivityAt: number | null;
  now: number;
  stallAfterMs: number;
}): boolean {
  if (input.probed || input.stopping || input.lastActivityAt === null) return false;
  return input.now - input.lastActivityAt >= input.stallAfterMs + STALL_PROBE_GRACE_MS;
}
