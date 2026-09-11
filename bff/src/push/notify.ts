import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { errorMessage } from "../errors.ts";
import { frameScopeKey, parseScopeKey } from "../session/buffer.ts";
import { type PushPayload, sendPush } from "./send.ts";
import type { PushSubscriptionStore } from "./store.ts";

/**
 * Where a push about this frame's conversation should open, or null when none
 * is due: the frame carries no scope, or a session is already watching it and
 * sees the event live. The shared first step of every watcher. The query shape
 * is read back by `readDeepLinkSelection` in web/src/lib/selection.ts.
 */
export function unwatchedConversationUrl(
  frame: WsProtocolMessage,
  isWatched: (scopeKey: string) => boolean,
): string | null {
  const scopeKey = frameScopeKey(frame);
  if (!scopeKey || isWatched(scopeKey)) return null;
  const [agentId, conversationId] = parseScopeKey(scopeKey);
  return `/?agent=${encodeURIComponent(agentId)}&conversation=${encodeURIComponent(conversationId)}`;
}

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
        log(`Push to ${record.endpoint} failed: ${errorMessage(error)}`);
      }
    }),
  );
}
