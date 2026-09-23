import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { frameScopeKey, parseScopeKey } from "./buffer.ts";

export interface ActiveScope {
  agent_id: string;
  conversation_id: string;
}

/**
 * Which conversations have an agent response in progress, across the whole
 * app-server.
 *
 * Browsers cannot work this out for themselves: the registry forwards a scope's
 * frames only to sessions subscribed to it, so a tab sees the conversation it
 * has open and nothing else. The BFF's upstream connection, by contrast, is
 * subscribed to every scope it has ever synced plus everything the periodic
 * sweep finds (`upstream/connection.ts` `subscribeToAllScopes`) — so a
 * cron-fired or Telegram-fired turn is visible here even when no browser ever
 * opened that conversation. A conversation created after the last sweep shows
 * up at the next one.
 *
 * Two signals, the same two `use-conversation.ts` uses for the open
 * conversation:
 * - `update_device_status` carries a full `is_processing` snapshot for its
 *   scope. Each one is authoritative, and the upstream reconnect forces one
 *   per scope (`force_device_status`), so the set heals itself.
 * - `turn_finished` ends a turn for its scope.
 *
 * `is_processing` stays true while a turn waits on an approval, which is still
 * a response in progress.
 */
export class ActivityTracker {
  private readonly active = new Set<string>();

  /** Fold one upstream frame in. True when the active set changed. */
  observe(frame: WsProtocolMessage): boolean {
    if (frame.type !== "update_device_status" && frame.type !== "turn_finished") return false;
    const key = frameScopeKey(frame);
    if (!key) return false;

    const processing =
      frame.type === "update_device_status" &&
      (frame as { device_status?: { is_processing?: unknown } }).device_status?.is_processing ===
        true;

    if (processing === this.active.has(key)) return false;
    if (processing) this.active.add(key);
    else this.active.delete(key);
    return true;
  }

  /** Forget everything — used when the upstream drops and the state is unknown. True when anything was cleared. */
  clear(): boolean {
    if (this.active.size === 0) return false;
    this.active.clear();
    return true;
  }

  snapshot(): ActiveScope[] {
    return [...this.active].map((key) => {
      const [agent_id, conversation_id] = parseScopeKey(key);
      return { agent_id, conversation_id };
    });
  }
}
