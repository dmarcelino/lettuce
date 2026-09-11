import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";

/** Sequence number the BFF attaches to every unsolicited frame. */
export const SEQ_FIELD = "__seq";

export type SequencedFrame = WsProtocolMessage & { [SEQ_FIELD]?: number };

export interface RuntimeScope {
  agent_id: string;
  conversation_id: string;
}

export interface BffHello {
  type: "__bff_hello";
  session_id: string;
  user: { email: string };
  upstream: ConnectionState;
  app_server_info: unknown;
  latest_seq: number;
}

export interface BffResumeResult {
  type: "__bff_resume_result";
  from_seq: number | null;
  latest_seq: number;
  replayed: number;
  resync_required: boolean;
}

export interface BffUpstreamState {
  type: "__bff_upstream_state";
  state: ConnectionState;
  app_server_info: unknown;
}

export interface BffError {
  type: "__bff_error";
  message: string;
  request_id?: string;
}

export type ConnectionState = "connecting" | "connected" | "disconnected";

export type BffControlFrame = BffHello | BffResumeResult | BffUpstreamState | BffError;

export function isBffControlFrame(frame: unknown): frame is BffControlFrame {
  if (!frame || typeof frame !== "object") return false;
  const type = (frame as { type?: unknown }).type;
  return typeof type === "string" && type.startsWith("__bff_");
}

export function frameSeq(frame: SequencedFrame): number | null {
  const seq = frame[SEQ_FIELD];
  return typeof seq === "number" ? seq : null;
}

export function scopeKey(scope: RuntimeScope): string {
  return `${scope.agent_id}::${scope.conversation_id}`;
}
