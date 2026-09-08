import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { frameScopeKey } from "../session/buffer.ts";
import { notify as defaultNotify } from "./notify.ts";
import type { PushSubscriptionStore } from "./store.ts";

/**
 * Fires a push on the ONE decided trigger: an agent turn completes while
 * nobody is watching that conversation. `is_processing` (on
 * `update_device_status`) is derived upstream from the turn lifecycle's
 * `kind === "active"`, and `WAITING_ON_APPROVAL` is one of the *active* loop
 * statuses — so it never edges false merely because a turn is paused on an
 * approval. A true->false transition only happens on genuine completion,
 * stop, or cancellation.
 *
 * A session with an empty `scopes` set (freshly opened, before its first
 * `resume`/scoped command) counts as "watching everything", so a push can be
 * suppressed in the brief window right after a browser reconnects and before
 * it re-subscribes. Acceptable: this can only make the watcher too quiet,
 * never too noisy.
 */
export class TurnCompletionWatcher {
  private readonly lastIsProcessing = new Map<string, boolean>();

  constructor(
    private readonly store: PushSubscriptionStore,
    private readonly log: (message: string) => void,
    /** Injectable for tests; defaults to the real push funnel. */
    private readonly notify: typeof defaultNotify = defaultNotify,
  ) {}

  observe(frame: WsProtocolMessage, isWatched: (scopeKey: string) => boolean): void {
    if (frame.type !== "update_device_status") return;

    const scopeKey = frameScopeKey(frame);
    if (!scopeKey) return;

    const isProcessing = frame.device_status.is_processing;
    const previous = this.lastIsProcessing.get(scopeKey);
    this.lastIsProcessing.set(scopeKey, isProcessing);

    // First observation for this scope just seeds the map — nothing to
    // compare against yet, so it never spuriously fires.
    if (previous === undefined) return;

    if (previous && !isProcessing && !isWatched(scopeKey)) {
      void this.notify(
        this.store,
        { title: "Letta", body: "Your agent finished its turn.", url: "/" },
        this.log,
      );
    }
  }
}
