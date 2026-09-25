import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { frameScopeKey } from "./buffer.ts";

export interface TurnError {
  turn_id: string;
  run_id: string | null;
  stop_reason: string;
  error: string;
  /** When the BFF saw the terminal frame — the frame itself carries no date. */
  at: string;
}

/** Most recent errors kept per conversation. */
export const TURN_ERRORS_PER_SCOPE = 10;
/** Conversations remembered at once; the least recently failed is dropped first. */
export const TURN_ERROR_SCOPES = 200;

/**
 * Terminal turn errors, per conversation, so a reload still shows them.
 *
 * The app-server reports a failed turn only live: a `loop_error` lifecycle
 * delta and `turn_finished.error`. Neither is written to the message store, so
 * `conversation_messages_list` — the cold-start transcript — has no trace of
 * it. A cron turn fails while nobody is watching, the push says "hit an error",
 * and the conversation looks spotless. The BFF sees every scope's
 * `turn_finished`, so it keeps the error here and the web client merges it back
 * into the rebuilt transcript.
 *
 * In memory only: a BFF restart forgets them, which the shutdown drain makes
 * rare during a turn.
 */
export class TurnErrorLog {
  private readonly scopes = new Map<string, TurnError[]>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  observe(frame: WsProtocolMessage): void {
    if (frame.type !== "turn_finished" || !frame.error) return;
    const key = frameScopeKey(frame);
    if (!key) return;

    const entries = this.scopes.get(key) ?? [];
    // Re-insert so Map order tracks recency; the oldest scope is evicted first.
    this.scopes.delete(key);
    entries.push({
      turn_id: frame.turn_id,
      run_id: frame.run_id ?? null,
      stop_reason: frame.stop_reason,
      error: frame.error,
      at: this.now().toISOString(),
    });
    if (entries.length > TURN_ERRORS_PER_SCOPE)
      entries.splice(0, entries.length - TURN_ERRORS_PER_SCOPE);
    this.scopes.set(key, entries);

    if (this.scopes.size > TURN_ERROR_SCOPES) {
      const oldest = this.scopes.keys().next().value;
      if (oldest !== undefined) this.scopes.delete(oldest);
    }
  }

  list(scopeKey: string): TurnError[] {
    return [...(this.scopes.get(scopeKey) ?? [])];
  }
}
