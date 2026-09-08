import { type PushPayload, sendPush } from "./send.ts";
import type { PushSubscriptionStore } from "./store.ts";

/**
 * The single funnel every push trigger sends through. Today there is exactly
 * one caller (turn-watcher.ts, on turn completion) — kept as a standalone
 * function anyway so a future trigger (approvals, cron results, errors) is a
 * new caller, not a rewrite.
 */
export async function notify(
  store: PushSubscriptionStore,
  payload: PushPayload,
  log: (message: string) => void,
): Promise<void> {
  const subscriptions = store.all();
  await Promise.all(
    subscriptions.map(async (record) => {
      try {
        const result = await sendPush(record, payload);
        if (result === "gone") store.remove(record.endpoint);
      } catch (error) {
        // One dead or misbehaving device must never block delivery to others.
        log(
          `Push to ${record.endpoint} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
}
