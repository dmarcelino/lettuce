import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { frameScopeKey } from "../session/buffer.ts";
import { notify as defaultNotify, type PushEventType } from "./notify.ts";
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

    const scopeKey = frameScopeKey(frame);
    if (!scopeKey || isWatched(scopeKey)) return;

    const [agentId, conversationId] = scopeKey.split("::") as [string, string];
    const eventType: PushEventType = frame.error ? "failed" : "completed";

    void this.notify(
      this.store,
      {
        title: "Letta",
        body: eventType === "failed" ? "Your agent hit an error." : "Your agent finished its turn.",
        url: `/?agent=${encodeURIComponent(agentId)}&conversation=${encodeURIComponent(conversationId)}`,
      },
      eventType,
      this.log,
    );
  }
}
