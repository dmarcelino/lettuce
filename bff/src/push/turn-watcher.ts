import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { notify as defaultNotify, type PushEventType, unwatchedConversationUrl } from "./notify.ts";
import type { PushSubscriptionStore } from "./store.ts";

/**
 * Fires a push when a turn ends — successfully or with an error — while
 * nobody is watching that conversation. `turn_finished` is emitted only on a
 * genuine terminal transition (letta-code: `finishListenerTurn`, called from
 * `turnLifecycle.finish()` reporting a finished transition) — never while a
 * turn is merely paused on an approval — so, unlike the `is_processing` edge
 * this watcher used to track, no per-scope state is needed: one frame, one
 * decision. It already carries a classified `error`, so completed vs failed
 * falls out directly instead of being inferred.
 */
export class TurnOutcomeWatcher {
  constructor(
    private readonly store: PushSubscriptionStore,
    private readonly log: (message: string) => void,
    /** Injectable for tests; defaults to the real push funnel. */
    private readonly notify: typeof defaultNotify = defaultNotify,
  ) {}

  observe(frame: WsProtocolMessage, isWatched: (scopeKey: string) => boolean): void {
    if (frame.type !== "turn_finished") return;

    const url = unwatchedConversationUrl(frame, isWatched, this.log);
    if (!url) return;

    const eventType: PushEventType = frame.error ? "failed" : "completed";

    void this.notify(
      this.store,
      {
        title: "Letta",
        body: frame.error ? failureBody(frame.error) : "Your agent finished its turn.",
        url,
      },
      eventType,
      this.log,
    );
  }
}

/** Longest error excerpt a push carries; notification UIs clip long bodies anyway. */
export const PUSH_ERROR_EXCERPT_CHARS = 120;

/**
 * The failure push names the failure. The error is reported nowhere the
 * transcript reloads from (see `session/turn-errors.ts`), so a bare "hit an
 * error" left the notification as the only trace, with nothing in it. Only the
 * first line: a provider error continues with its raw HTTP body.
 */
export function failureBody(error: string): string {
  const firstLine = error.trim().split("\n", 1)[0]?.trim() ?? "";
  if (!firstLine) return "Your agent hit an error.";
  const excerpt =
    firstLine.length > PUSH_ERROR_EXCERPT_CHARS
      ? `${firstLine.slice(0, PUSH_ERROR_EXCERPT_CHARS - 1)}…`
      : firstLine;
  return `Your agent hit an error: ${excerpt}`;
}
