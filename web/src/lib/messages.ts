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
  | "task"
  | "approval_request"
  | "approval_response"
  | "event"
  | "notice";

/** The filter groups offered in the UI. */
export type FilterGroup = "user" | "agent" | "tools" | "tasks" | "system";

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
  /** loop_error: the run it belongs to, used to fold the duplicate pair. */
  runId?: string;
  /** reasoning */
  redacted?: boolean;
  /** Set while the entry is still being streamed. */
  streaming?: boolean;
  /** A machine-injected block lifted out of a user message; rendered collapsed. */
  reminder?: boolean;
  /** task: the summary line, shown in the header. */
  title?: string;
  /** task: the originating task id. */
  taskId?: string;
  /** user: arrived over a channel (telegram, slack) rather than being typed. */
  channel?: string;
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
  // Background work reporting back carries content you asked for, unlike the
  // environment plumbing in "system" — so it gets its own switch.
  task: "tasks",
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
  tasks: "Tasks",
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
 * These are not something the person typed, so rendering them in the user
 * bubble is wrong twice over: it credits them to the human, and — because an
 * opening tag on its own line is a CommonMark HTML block that react-markdown
 * drops along with the paragraph after it — the body silently disappears.
 *
 * The tag text is the only signal available. No structured marker survives into
 * history: `otid` is a bare UUID on every path, `role` is always "user", and
 * `created_by_id` is absent both for notification batches and for real messages
 * here. letta-code parses text everywhere it consumes these too, so this is the
 * sanctioned approach rather than a workaround.
 */
const INJECTED_BLOCKS: Record<string, EntryKind> = {
  "system-reminder": "system",
  // Legacy: no longer constructed upstream, still parsed there for old history.
  "system-alert": "system",
  "stop-hook": "system",
  skill_content: "system",
  loaded_skills: "system",
  "task-notification": "task",
  // A person talking from another device, not machine noise — stays a user
  // message, just labelled with where it came from.
  "channel-notification": "user",
};

const INJECTED_BLOCK_RE = new RegExp(
  // The tag may carry attributes (`<skill_content name="...">`). The closing tag
  // is optional so a block still mid-stream is recognised rather than swallowing
  // the rest of the transcript once it completes.
  `<(${Object.keys(INJECTED_BLOCKS).join("|")})(\\s[^>]*)?>([\\s\\S]*?)(?:</\\1>|$)`,
  "g",
);

/**
 * A message that OPENS with an unknown tag block.
 *
 * Pre-loaded skills inject `<${skillId}>…</${skillId}>` — the tag name IS the
 * skill id, so there is no fixed list to match. Two guards keep this off real
 * prose: the block must start the message, and it must be properly closed (no
 * open-ended fallback). So "is 3 < 5?" and "use <div> in html" are untouched,
 * while a skill dump followed by a question still splits correctly.
 */
const LEADING_TAG_RE = /^<([a-z][a-z0-9_-]*)>([\s\S]*?)<\/\1>/;

/** Tags that are real HTML, so a message using them is prose, not an injection. */
const HTML_TAGS = new Set([
  "p",
  "div",
  "span",
  "a",
  "b",
  "i",
  "em",
  "strong",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "img",
  "blockquote",
]);

/** The trailing pointer upstream appends OUTSIDE the closing tag. */
const TRANSCRIPT_LINE_RE = /^Full transcript available at: .*$/gm;

interface InjectedBlock {
  tag: string;
  kind: EntryKind;
  attrs: string;
  body: string;
}

/** Pull out every known block, plus the whole-message skill case. */
function extractBlocks(text: string): { blocks: InjectedBlock[]; prose: string } {
  const blocks: InjectedBlock[] = [];
  let prose = text
    .replace(INJECTED_BLOCK_RE, (_match, tag: string, attrs: string | undefined, body: string) => {
      blocks.push({
        tag,
        kind: INJECTED_BLOCKS[tag] ?? "system",
        attrs: attrs ?? "",
        body: body.trim(),
      });
      return "";
    })
    .replace(TRANSCRIPT_LINE_RE, "")
    .trim();

  if (blocks.length === 0) {
    const leading = LEADING_TAG_RE.exec(prose);
    if (leading && !HTML_TAGS.has(leading[1] ?? "")) {
      blocks.push({
        tag: leading[1] ?? "",
        kind: "system",
        attrs: "",
        body: (leading[2] ?? "").trim(),
      });
      prose = prose.slice(leading[0].length).trim();
    }
  }
  return { blocks, prose };
}

/** First `<tag>value</tag>` inside a block body. */
function innerTag(body: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
  return match?.[1]?.trim() || undefined;
}

/**
 * Task notifications come in three incompatible shapes — the full subagent/Bash
 * form, a Monitor variant with no status and a nested <event>, and a reflection
 * variant that is a summary and nothing else. Only <summary> is common to all,
 * so every field is optional and the raw body is the fallback.
 */
function taskEntry(base: TranscriptEntry, body: string): TranscriptEntry {
  const summary = innerTag(body, "summary");
  const status = innerTag(body, "status");
  const result = innerTag(body, "result");
  const taskId = innerTag(body, "task-id");

  return {
    ...base,
    kind: "task",
    // Never an empty card: without a summary the raw block is still readable.
    ...(summary ? { title: summary } : { title: body.slice(0, 120) }),
    ...(taskId ? { taskId } : {}),
    // Absent status (Monitor) must not read as a failure, so no badge at all.
    ...(status ? { status: status === "completed" ? "success" : "error" } : {}),
    text: result ?? (summary ? "" : body),
  };
}

/** `<channel-notification channel="telegram">` → the channel name. */
function channelName(attrs: string): string | undefined {
  return /channel="([^"]+)"/.exec(attrs)?.[1];
}

/** Whatever the person actually wrote, with machine-injected blocks removed. */
export function stripInjectedBlocks(text: string): string {
  if (!text.includes("<")) return text.trim();
  return extractBlocks(text).prose;
}

/**
 * Expand one user entry into its injected blocks plus whatever the person
 * actually wrote. Any other entry passes through untouched.
 */
function splitInjectedBlocks(entry: TranscriptEntry): TranscriptEntry[] {
  if (entry.kind !== "user" || !entry.text.includes("<")) return [entry];

  const { blocks, prose } = extractBlocks(entry.text);
  if (blocks.length === 0) return [entry];

  const out: TranscriptEntry[] = blocks.map((block, index) => {
    const base: TranscriptEntry = { ...entry, id: `${entry.id}:block:${index}` };
    if (block.kind === "task") return taskEntry(base, block.body);
    if (block.kind === "user") {
      const channel = channelName(block.attrs);
      return { ...base, text: block.body, ...(channel ? { channel } : {}) };
    }
    return { ...base, kind: "system", reminder: true, text: block.body };
  });

  // A message that was nothing but injected blocks leaves no user bubble behind.
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

/**
 * The error notice this one merely repeats, or null.
 *
 * ONE failure emits TWO loop_error deltas upstream. While the stream drains,
 * `turn.ts` emits a non-terminal notice off the error chunk and stashes the
 * chunk in `latestErrorInfoRef`; at the stop it emits a terminal one whose
 * message is `latestErrorInfo.detail || latestErrorInfo.message`. Against the
 * local backend those are the same sentence — `localErrorChunk` fills both
 * fields from a single `normalizeLocalProviderError` — so the transcript drew
 * the same error twice. Each delta carries its own `lifecycle-<uuid>`, so
 * keying on the id cannot catch it, and the fork carries zero delta so it
 * cannot be fixed at the source.
 *
 * The match is kept tight so a real repeat is never swallowed: when both
 * notices name a run, only the same run folds — errors from different turns
 * stay separate. Without a run to key on, only a repeat of the MOST RECENT
 * notice folds, which is the ordinary adjacent-log-line collapse and cannot
 * reach back across a turn.
 */
function duplicateErrorNotice(
  transcript: Transcript,
  text: string,
  runId: string,
): TranscriptEntry | null {
  let latest: TranscriptEntry | null = null;
  for (const entry of transcript.values()) {
    latest = entry;
    if (
      runId &&
      entry.kind === "notice" &&
      entry.level === "error" &&
      entry.runId === runId &&
      entry.text === text
    ) {
      return entry;
    }
  }
  if (runId) return null;

  // No run to key on, so fold only what immediately precedes this — anything at
  // all in between, an assistant message included, means the turn carried on and
  // this is a second failure rather than the same one being finalised.
  if (
    latest?.kind === "notice" &&
    latest.level === "error" &&
    !latest.runId &&
    latest.text === text
  ) {
    return latest;
  }
  return null;
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

  const runId = typeof raw.run_id === "string" ? raw.run_id : "";
  // Fold the terminal half of a duplicated error into the entry the
  // non-terminal half already made, keeping that entry's `seenAt` so it holds
  // its place — `sortedEntries` orders on `seenAt`. No repeat count: this is
  // one failure reported twice, so a badge would assert something untrue.
  const duplicate =
    messageType === "loop_error" ? duplicateErrorNotice(transcript, text, runId) : null;

  transcript.set(duplicate?.id ?? id, {
    id: duplicate?.id ?? id,
    kind: "notice",
    date: typeof raw.date === "string" ? raw.date : new Date().toISOString(),
    seenAt: duplicate?.seenAt ?? seq,
    text,
    level,
    dim,
    ...(runId ? { runId } : {}),
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
