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
  log?: (message: string) => void,
): string | null {
  const scopeKey = frameScopeKey(frame);
  if (!scopeKey) return null;
  if (isWatched(scopeKey)) {
    // Logged because a suppressed push and a broken one used to look identical
    // from outside: silence either way.
    log?.(`Push for ${frame.type} in ${scopeKey} suppressed: a visible session is watching it`);
    return null;
  }
  return conversationUrl(scopeKey);
}

/** The deep link a push about this conversation opens; see `readDeepLinkSelection`. */
export function conversationUrl(scopeKey: string): string {
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
  const registered = store.all();
  const subscriptions = registered.filter((record) => record.preferences[eventType]);
  if (subscriptions.length === 0) {
    log(`Push (${eventType}): no device wants it (${registered.length} registered)`);
    return;
  }

  let sent = 0;
  await Promise.all(
    subscriptions.map(async (record) => {
      try {
        const result = await sendPush(record, payload);
        if (result === "gone") store.remove(record.endpoint);
        else sent += 1;
      } catch (error) {
        // One dead or misbehaving device must never block delivery to others.
        log(`Push to ${record.endpoint} failed: ${errorMessage(error)}`);
      }
    }),
  );
  log(`Push (${eventType}): sent to ${sent} of ${subscriptions.length} device(s)`);
}
