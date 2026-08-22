/**
 * Normalizes Letta messages — whether streamed as deltas or loaded as history —
 * into a flat transcript the UI can render.
 *
 * Streaming sends many partial frames per message: assistant text, reasoning,
 * and tool-call arguments all arrive in fragments. Those fragments are grouped
 * by a canonical key resolved from `otid` and `id` (see StreamIndex — `id`
 * alone is per-frame, not per-message) and string fields are appended, so a
 * delta and a full history record converge on the same shape.
 */

export type EntryKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool_call"
  | "tool_return"
  | "system"
  | "approval_request"
  | "approval_response"
  | "event"
  | "notice";

/** The four filter groups offered in the UI. */
export type FilterGroup = "user" | "agent" | "tools" | "system";

export interface TranscriptEntry {
  id: string;
  kind: EntryKind;
  date: string;
  /** Ordering key: first time this id was seen. */
  seenAt: number;
  text: string;
  /** tool_call / approval_request */
  toolName?: string;
  toolArgs?: string;
  toolCallId?: string;
  /** tool_return */
  status?: "success" | "error";
  /** notice */
  level?: "info" | "success" | "warning" | "error";
  /** reasoning */
  redacted?: boolean;
  /** Set while the entry is still being streamed. */
  streaming?: boolean;
  /** A machine-injected block lifted out of a user message; rendered collapsed. */
  reminder?: boolean;
  /**
   * Rendered by us on send, before any server frame. The app-server only echoes
   * a user message when it was queued, so without this your own message never
   * appears until a reload.
   */
  local?: boolean;
  /** Rendered dimmed (command output that is informational only). */
  dim?: boolean;
  /** Subagent that produced this entry, when not the main agent. */
  subagentId?: string;
}

export const FILTER_GROUPS: Record<EntryKind, FilterGroup> = {
  user: "user",
  assistant: "agent",
  reasoning: "agent",
  tool_call: "tools",
  tool_return: "tools",
  approval_request: "tools",
  approval_response: "tools",
  system: "system",
  event: "system",
  notice: "system",
};

export const FILTER_LABELS: Record<FilterGroup, string> = {
  user: "You",
  agent: "Agent",
  tools: "Tools",
  system: "System",
};

export type Transcript = Map<string, TranscriptEntry>;

/**
 * Alias maps that hold one streamed message together.
 *
 * `delta.id` is NOT stable: the local backend's `createStoredChunk` mints a
 * fresh `letta-msg-N` for every chunk and strips the provider's own id. `otid`
 * is memoized per contiguous content segment and is the only field constant
 * across a message — a real capture showed 98 deltas, 98 ids, 1 otid. Keying on
 * `id` therefore produces one entry per word.
 *
 * Both directions are needed because streams mix the two: some chunks carry
 * only `id`, some only `otid`, some both. This mirrors `resolveAssistantLineId`
 * in letta-code's own TUI accumulator, which is the reference implementation.
 */
export interface StreamIndex {
  byMessageId: Map<string, string>;
  byOtid: Map<string, string>;
}

export function createStreamIndex(): StreamIndex {
  return { byMessageId: new Map(), byOtid: new Map() };
}

/**
 * The key this message accumulates under, remembering the aliases so later
 * chunks of the same message resolve to it whichever field they carry.
 */
function resolveCanonicalKey(
  index: StreamIndex,
  transcript: Transcript,
  id: string,
  otid: string,
  kind: EntryKind,
): string {
  // `||` not `??`: the absent fields are empty strings, not undefined.
  let canonical =
    (id ? index.byMessageId.get(id) : undefined) ??
    (otid ? index.byOtid.get(otid) : undefined) ??
    (id || otid);
  if (!canonical) return "";

  // Providers can reuse one id/otid across an assistant and a reasoning block.
  // Namespacing on collision keeps a thought out of the spoken message.
  const existing = transcript.get(canonical);
  if (existing && existing.kind !== kind) canonical = `${kind}:${canonical}`;

  if (id) index.byMessageId.set(id, canonical);
  if (otid) index.byOtid.set(otid, canonical);
  return canonical;
}

/**
 * Machine-injected blocks that ride along inside a user message.
 *
 * They are not something the person typed, so rendering them in the user
 * bubble is wrong twice over: it attributes them to the human, and — because
 * an opening tag on its own line is a CommonMark HTML block that react-markdown
 * drops along with the paragraph after it — the body silently disappears.
 * Splitting them out before rendering fixes both.
 */
const INJECTED_BLOCK_TAGS = ["system-reminder", "letta-guide"] as const;

const INJECTED_BLOCK_RE = new RegExp(
  // The closing tag is optional so a block still mid-stream is recognised
  // rather than swallowing the rest of the transcript when it completes.
  `<(${INJECTED_BLOCK_TAGS.join("|")})>([\\s\\S]*?)(?:</\\1>|$)`,
  "g",
);

/**
 * Expand one user entry into its injected blocks plus whatever the person
 * actually wrote. Any other entry passes through untouched.
 */
function splitInjectedBlocks(entry: TranscriptEntry): TranscriptEntry[] {
  if (entry.kind !== "user" || !entry.text.includes("<")) return [entry];

  const blocks: string[] = [];
  const prose = entry.text
    .replace(INJECTED_BLOCK_RE, (_match, _tag, body: string) => {
      blocks.push(body.trim());
      return "";
    })
    .trim();

  if (blocks.length === 0) return [entry];

  const out: TranscriptEntry[] = blocks.map((text, index) => ({
    ...entry,
    id: `${entry.id}:reminder:${index}`,
    kind: "system" as const,
    reminder: true,
    text,
  }));
  // A message that was nothing but reminders leaves no user bubble behind.
  if (prose) out.push({ ...entry, text: prose });
  return out;
}

/**
 * Show the user's own message immediately.
 *
 * `emitDequeuedUserMessage` is the only thing that puts a user message on the
 * wire, and both call sites are guarded by `consumeQueuedTurn` — so the echo
 * arrives ONLY for a message that was queued behind a busy agent. On the
 * ordinary path nothing comes back, and the transcript would show the reply
 * without the question.
 *
 * The client message id becomes the server's `otid`, so registering it in the
 * stream index means a later echo resolves onto this same entry instead of
 * creating a second one.
 */
export function addLocalUserMessage(
  transcript: Transcript,
  index: StreamIndex,
  clientMessageId: string,
  text: string,
  seq: number,
): void {
  index.byOtid.set(clientMessageId, clientMessageId);
  transcript.set(clientMessageId, {
    id: clientMessageId,
    kind: "user",
    date: new Date().toISOString(),
    seenAt: seq,
    text,
    local: true,
    streaming: false,
  });
}

export function sortedEntries(transcript: Transcript): TranscriptEntry[] {
  return (
    [...transcript.values()]
      .sort((a, b) => {
        if (a.seenAt !== b.seenAt) return a.seenAt - b.seenAt;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      // After sorting, so an extracted block keeps its parent's position.
      .flatMap(splitInjectedBlocks)
  );
}

export function filterEntries(
  entries: TranscriptEntry[],
  active: ReadonlySet<FilterGroup>,
): TranscriptEntry[] {
  if (active.size === 0) return entries;
  return entries.filter((entry) => active.has(FILTER_GROUPS[entry.kind]));
}

/** Letta content fields are either a plain string or an array of content parts. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") return text;
      }
      return "";
    })
    .join("");
}

interface ToolCallish {
  name?: unknown;
  arguments?: unknown;
  tool_call_id?: unknown;
}

function readToolCall(message: Record<string, unknown>): ToolCallish | null {
  const single = message.tool_call;
  if (single && typeof single === "object") return single as ToolCallish;
  const many = message.tool_calls;
  if (Array.isArray(many) && many.length > 0 && typeof many[0] === "object") {
    return many[0] as ToolCallish;
  }
  if (many && typeof many === "object") return many as ToolCallish;
  return null;
}

function kindForMessageType(messageType: string): EntryKind | null {
  switch (messageType) {
    case "user_message":
      return "user";
    case "assistant_message":
      return "assistant";
    case "reasoning_message":
    case "hidden_reasoning_message":
      return "reasoning";
    case "tool_call_message":
      return "tool_call";
    case "tool_return_message":
      return "tool_return";
    case "system_message":
      return "system";
    case "approval_request_message":
      return "approval_request";
    case "approval_response_message":
      return "approval_response";
    case "event_message":
      return "event";
    default:
      return null;
  }
}

/** Merge one Letta message (delta or complete) into the transcript. */
export function applyMessage(
  transcript: Transcript,
  raw: unknown,
  options: { streaming: boolean; seq: number; subagentId?: string; index?: StreamIndex },
): void {
  if (!raw || typeof raw !== "object") return;
  const message = raw as Record<string, unknown>;

  const messageType = typeof message.message_type === "string" ? message.message_type : "";
  const kind = kindForMessageType(messageType);
  if (!kind) return;

  const id = typeof message.id === "string" ? message.id : "";
  const otid = typeof message.otid === "string" ? message.otid : "";
  // A chunk with an otid but no id is a real shape (a raw pre-store provider
  // chunk); only a chunk with neither is unaddressable.
  if (!id && !otid) return;

  // History carries a stable id and no otid, so it still keys by id and the
  // replay path is unchanged.
  const key = options.index
    ? resolveCanonicalKey(options.index, transcript, id, otid, kind)
    : id || otid;
  if (!key) return;

  const existing = transcript.get(key);
  const entry: TranscriptEntry = existing ?? {
    id: key,
    kind,
    date: typeof message.date === "string" ? message.date : new Date().toISOString(),
    seenAt: options.seq,
    text: "",
    ...(options.subagentId ? { subagentId: options.subagentId } : {}),
  };

  // A later frame may reveal the concrete type after a generic first chunk.
  entry.kind = kind;
  entry.streaming = options.streaming;

  switch (kind) {
    case "user":
    case "assistant": {
      const chunk = contentToText(message.content);
      // History replaces; streaming appends. A replayed history record for a
      // message we streamed must not double the text.
      //
      // The exception is an entry we rendered ourselves on send: the server's
      // echo carries the whole message, so appending it to our copy would show
      // the text twice. Replace once, then let normal append semantics resume
      // in case the echo is itself chunked.
      if (options.streaming && entry.local) {
        entry.text = chunk;
        entry.local = false;
      } else {
        entry.text = options.streaming ? entry.text + chunk : chunk;
      }
      break;
    }
    case "reasoning": {
      if (messageType === "hidden_reasoning_message") {
        entry.redacted = true;
        const hidden = message.hidden_reasoning;
        entry.text = typeof hidden === "string" ? hidden : "(reasoning hidden)";
      } else {
        const chunk = typeof message.reasoning === "string" ? message.reasoning : "";
        entry.text = options.streaming ? entry.text + chunk : chunk;
      }
      break;
    }
    case "tool_call":
    case "approval_request": {
      const call = readToolCall(message);
      if (call) {
        if (typeof call.name === "string" && call.name) entry.toolName = call.name;
        if (typeof call.tool_call_id === "string" && call.tool_call_id) {
          entry.toolCallId = call.tool_call_id;
        }
        if (typeof call.arguments === "string") {
          entry.toolArgs = options.streaming
            ? (entry.toolArgs ?? "") + call.arguments
            : call.arguments;
        }
      }
      break;
    }
    case "tool_return": {
      const value = message.tool_return;
      entry.text = typeof value === "string" ? value : JSON.stringify(value ?? "");
      entry.status = message.status === "error" ? "error" : "success";
      if (typeof message.tool_call_id === "string") entry.toolCallId = message.tool_call_id;
      break;
    }
    case "system": {
      entry.text = contentToText(message.content);
      break;
    }
    case "approval_response": {
      const approved = message.approve === true;
      const reason = typeof message.reason === "string" ? message.reason : "";
      entry.text = approved ? "Approved" : `Denied${reason ? `: ${reason}` : ""}`;
      entry.status = approved ? "success" : "error";
      break;
    }
    case "event": {
      const eventType = typeof message.event_type === "string" ? message.event_type : "event";
      entry.text = eventType === "compaction" ? "Conversation compacted" : eventType;
      break;
    }
    case "notice":
      break;
  }

  transcript.set(key, entry);
}

/** Non-message lifecycle deltas: status lines, retries, errors, command output. */
export function applyNotice(
  transcript: Transcript,
  raw: Record<string, unknown>,
  seq: number,
): void {
  const messageType = typeof raw.message_type === "string" ? raw.message_type : "";
  const id = typeof raw.id === "string" ? raw.id : `${messageType}-${seq}`;

  let text = "";
  let level: TranscriptEntry["level"] = "info";
  let dim = false;

  switch (messageType) {
    case "status":
      text = typeof raw.message === "string" ? raw.message : "";
      level = raw.level === "warning" ? "warning" : raw.level === "success" ? "success" : "info";
      break;
    case "retry":
      text = typeof raw.message === "string" ? raw.message : "Retrying";
      level = "warning";
      break;
    case "loop_error":
      text = typeof raw.message === "string" ? raw.message : "Error";
      level = "error";
      break;
    case "command_end":
    case "slash_command_end": {
      const command = typeof raw.command_id === "string" ? raw.command_id : "command";
      const output = typeof raw.output === "string" ? raw.output : "";
      text = `/${command}\n${output}`.trim();
      level = raw.success === false ? "error" : "info";
      dim = raw.dim_output === true;
      break;
    }
    case "client_tool_start":
    case "client_tool_end":
    case "command_start":
    case "slash_command_start":
      return; // Start markers add noise without the paired result.
    default:
      return;
  }

  if (!text) return;

  transcript.set(id, {
    id,
    kind: "notice",
    date: typeof raw.date === "string" ? raw.date : new Date().toISOString(),
    seenAt: seq,
    text,
    level,
    dim,
  });
}

/** Route one `stream_delta.delta` into the transcript. */
export function applyStreamDelta(
  transcript: Transcript,
  index: StreamIndex,
  delta: unknown,
  seq: number,
  subagentId?: string,
): void {
  if (!delta || typeof delta !== "object") return;
  const record = delta as Record<string, unknown>;

  if (record.type === "message") {
    applyMessage(transcript, record, {
      streaming: true,
      seq,
      index,
      ...(subagentId ? { subagentId } : {}),
    });
    return;
  }
  applyNotice(transcript, record, seq);
}

/**
 * Rebuild a transcript from `conversation_messages_list`.
 *
 * That endpoint returns messages NEWEST FIRST (verified against the backend:
 * the array runs descending by `date`). `seenAt` drives the render order, so
 * using the raw array index put the newest message at the top and rendered the
 * whole conversation backwards — the reply above the question that prompted it.
 */
export function transcriptFromHistory(messages: readonly unknown[]): Transcript {
  const transcript: Transcript = new Map();
  const oldestFirst = [...messages].reverse();
  oldestFirst.forEach((message, index) => {
    applyMessage(transcript, message, { streaming: false, seq: index });
  });
  for (const entry of transcript.values()) entry.streaming = false;
  return transcript;
}

/** Mark every streaming entry complete (turn finished or aborted). */
export function settleStreaming(transcript: Transcript): void {
  for (const entry of transcript.values()) {
    if (entry.streaming) entry.streaming = false;
  }
}
