import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";

export interface BufferedFrame {
  seq: number;
  /** See `scopeKeyOf`; null for connection-wide frames. */
  scopeKey: string | null;
  frame: WsProtocolMessage;
}

export interface ReplayResult {
  frames: BufferedFrame[];
  /**
   * True when the requested starting point has already been evicted, so the
   * client must rebuild from `conversation_messages_list` instead of a replay.
   */
  resyncRequired: boolean;
  latestSeq: number;
}

/**
 * A bounded, monotonically sequenced log of unsolicited frames from the
 * app-server, so a browser tab that was backgrounded can replay exactly what it
 * missed instead of refetching history.
 *
 * One global ring rather than a ring per conversation: at personal-assistant
 * scale the total frame rate is what matters, and a single sequence space keeps
 * ordering across scopes trivially correct.
 *
 * A ring, not an array with `splice`: sequences are contiguous integers, so an
 * entry's slot is `(seq - 1) % capacity` and eviction is just overwriting the
 * slot the next sequence lands on. Appending to a plain array and splicing the
 * front off once full is O(capacity) per frame — at 5000 frames that is a
 * 5000-element memmove for every single frame, on the hot path of every
 * streamed token.
 */
export class FrameBuffer {
  private readonly slots: (BufferedFrame | undefined)[];
  private nextSeq = 1;

  constructor(private readonly capacity: number) {
    this.slots = new Array<BufferedFrame | undefined>(capacity);
  }

  /** Sequence of the most recent frame; 0 when nothing has been buffered. */
  get latestSeq(): number {
    return this.nextSeq - 1;
  }

  /** How many frames are currently retained. */
  get size(): number {
    return Math.min(this.latestSeq, this.capacity);
  }

  /** Sequence of the oldest still-replayable frame. */
  private get oldestSeq(): number {
    return Math.max(1, this.nextSeq - this.capacity);
  }

  append(frame: WsProtocolMessage, scopeKey: string | null): BufferedFrame {
    const entry: BufferedFrame = { seq: this.nextSeq, scopeKey, frame };
    this.slots[this.indexFor(this.nextSeq)] = entry;
    this.nextSeq += 1;
    return entry;
  }

  private indexFor(seq: number): number {
    return (seq - 1) % this.capacity;
  }

  /**
   * Frames newer than `fromSeq`, optionally narrowed to a set of scopes.
   * `fromSeq === null` means a fresh client with no prior state: nothing to
   * replay, and no resync needed.
   */
  replayFrom(fromSeq: number | null, scopeKeys?: ReadonlySet<string>): ReplayResult {
    if (fromSeq === null) {
      return { frames: [], resyncRequired: false, latestSeq: this.latestSeq };
    }

    if (fromSeq > this.latestSeq) {
      // Client is ahead of us — only possible after a BFF restart cleared the
      // buffer. Treat it as a cold start.
      return { frames: [], resyncRequired: true, latestSeq: this.latestSeq };
    }

    if (this.size > 0 && fromSeq < this.oldestSeq - 1) {
      return { frames: [], resyncRequired: true, latestSeq: this.latestSeq };
    }

    const frames: BufferedFrame[] = [];
    // Start at the first sequence still retained: a client asking for something
    // older than the oldest frame but within the "no resync" boundary
    // (fromSeq === oldestSeq - 1) must still get everything we have.
    const start = Math.max(fromSeq + 1, this.oldestSeq);
    for (let seq = start; seq <= this.latestSeq; seq += 1) {
      const entry = this.slots[this.indexFor(seq)];
      if (!entry || entry.seq !== seq) continue;
      if (scopeKeys && entry.scopeKey !== null && !scopeKeys.has(entry.scopeKey)) continue;
      frames.push(entry);
    }
    return { frames, resyncRequired: false, latestSeq: this.latestSeq };
  }
}

/**
 * The key one `{agent_id, conversation_id}` scope is tracked under — by this
 * buffer, the session registry, the upstream connection and the push watchers.
 */
export function scopeKeyOf(agentId: string, conversationId: string): string {
  return `${agentId}::${conversationId}`;
}

/** Inverse of `scopeKeyOf`. */
export function parseScopeKey(scopeKey: string): [agentId: string, conversationId: string] {
  return scopeKey.split("::") as [string, string];
}

/** The frame's scope key (see `scopeKeyOf`), if it carries a scope. */
export function frameScopeKey(frame: WsProtocolMessage): string | null {
  const runtime = (frame as { runtime?: unknown }).runtime;
  if (runtime && typeof runtime === "object") {
    const scope = runtime as { agent_id?: unknown; conversation_id?: unknown };
    if (typeof scope.agent_id === "string" && typeof scope.conversation_id === "string") {
      return scopeKeyOf(scope.agent_id, scope.conversation_id);
    }
  }
  // `control_request` carries its scope as flat fields rather than an envelope.
  const flat = frame as { agent_id?: unknown; conversation_id?: unknown };
  if (typeof flat.agent_id === "string" && typeof flat.conversation_id === "string") {
    return scopeKeyOf(flat.agent_id, flat.conversation_id);
  }
  return null;
}
