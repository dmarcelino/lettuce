import { type PushPayload, sendPush } from "./send.ts";
import type { PushSubscriptionStore } from "./store.ts";

/** Which per-device preference gates this notification. */
export type PushEventType = "completed" | "failed" | "approval";

/**
 * The single funnel every push trigger sends through. Each caller (turn
 * completion/failure, approval-needed) passes its own `eventType`, and this
 * is the one place that checks a device's preference for it before sending —
 * watchers stay simple and never look at preferences themselves.
 */
export async function notify(
  store: PushSubscriptionStore,
  payload: PushPayload,
  eventType: PushEventType,
  log: (message: string) => void,
): Promise<void> {
  const subscriptions = store.all().filter((record) => record.preferences[eventType]);
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
