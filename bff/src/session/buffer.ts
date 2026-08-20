import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";

export interface BufferedFrame {
  seq: number;
  /** `${agent_id}::${conversation_id}`, or null for connection-wide frames. */
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
 */
export class FrameBuffer {
  private readonly frames: BufferedFrame[] = [];
  private nextSeq = 1;

  constructor(private readonly capacity: number) {}

  /** Sequence of the most recent frame; 0 when nothing has been buffered. */
  get latestSeq(): number {
    return this.nextSeq - 1;
  }

  /** Sequence of the oldest still-replayable frame. */
  get oldestSeq(): number {
    return this.frames[0]?.seq ?? this.nextSeq;
  }

  append(frame: WsProtocolMessage, scopeKey: string | null): BufferedFrame {
    const entry: BufferedFrame = { seq: this.nextSeq, scopeKey, frame };
    this.nextSeq += 1;
    this.frames.push(entry);
    if (this.frames.length > this.capacity) {
      this.frames.splice(0, this.frames.length - this.capacity);
    }
    return entry;
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

    if (this.frames.length > 0 && fromSeq < this.oldestSeq - 1) {
      return { frames: [], resyncRequired: true, latestSeq: this.latestSeq };
    }

    const frames = this.frames.filter(
      (entry) =>
        entry.seq > fromSeq &&
        (!scopeKeys || entry.scopeKey === null || scopeKeys.has(entry.scopeKey)),
    );
    return { frames, resyncRequired: false, latestSeq: this.latestSeq };
  }
}

/** Extract `${agent_id}::${conversation_id}` from a frame, if it carries a scope. */
export function frameScopeKey(frame: WsProtocolMessage): string | null {
  const runtime = (frame as { runtime?: unknown }).runtime;
  if (runtime && typeof runtime === "object") {
    const scope = runtime as { agent_id?: unknown; conversation_id?: unknown };
    if (typeof scope.agent_id === "string" && typeof scope.conversation_id === "string") {
      return `${scope.agent_id}::${scope.conversation_id}`;
    }
  }
  // `control_request` carries its scope as flat fields rather than an envelope.
  const flat = frame as { agent_id?: unknown; conversation_id?: unknown };
  if (typeof flat.agent_id === "string" && typeof flat.conversation_id === "string") {
    return `${flat.agent_id}::${flat.conversation_id}`;
  }
  return null;
}
