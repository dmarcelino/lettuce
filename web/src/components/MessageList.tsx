import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { collectFileTokens } from "../lib/file-links.ts";
import type { TranscriptEntry } from "../lib/messages.ts";
import { parseToolArgs, summarizeToolCall } from "../lib/tool-summary.ts";
import { type FileLinks, useFileLinks } from "../state/use-file-links.ts";
import type { SessionApi } from "../state/use-session.ts";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";

interface Props {
  entries: TranscriptEntry[];
  processing: boolean;
  session: SessionApi;
  /** The runtime's working directory, used to shorten paths in tool summaries. */
  cwd: string | null;
  /** Open a workspace file the agent linked, in the app's file viewer. */
  onOpenFile: (path: string) => void;
}

const KIND_LABEL: Record<string, string> = {
  user: "You",
  assistant: "Agent",
  reasoning: "Thinking",
  tool_call: "Tool",
  tool_return: "Result",
  system: "System",
  task: "Task",
  // Every tool call arrives as an `approval_request_message`, whether or not it
  // needed approving — the real prompt is the ApprovalSheet, driven by
  // `control_request`. Labelling these "Approval" implied a decision that was
  // never asked for, so they read as what they are.
  approval_request: "Tool",
  approval_response: "Approval",
  event: "Event",
  notice: "",
};

/** Pretty-print JSON tool arguments, falling back to the raw string mid-stream. */
function formatArgs(args: string | undefined): string {
  if (!args) return "";
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

/** First non-blank line of a string, trimmed — the one-line preview. */
function firstLine(text: string | undefined): string {
  if (!text) return "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** Clip to n characters with an ellipsis. */
function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

export function MessageList({ entries, processing, session, cwd, onOpenFile }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileLinks = useFileLinks(session, cwd);
  // Auto-scroll only while the reader is at the bottom, so scrolling up to read
  // history is not yanked away by an incoming token.
  const [stuck, setStuck] = useState(true);
  const stuckRef = useRef(true);
  stuckRef.current = stuck;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !stuckRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [entries, processing]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => {
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      setStuck(distance < 80);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  // Index every tool return by its call id, and note which returns get folded
  // into a call so the standalone entry is dropped from the list.
  //
  // Memoised on `entries`: these two passes are O(n) over the whole transcript,
  // and the list re-renders on every streamed token. Rebuilding them each time
  // also produced fresh Map/Set identities per render, which would defeat the
  // memo on the rows below for no reason.
  const { returnByCall, pairedReturnIds } = useMemo(() => {
    const byCall = new Map<string, TranscriptEntry>();
    for (const entry of entries) {
      if (entry.kind === "tool_return" && entry.toolCallId && !byCall.has(entry.toolCallId)) {
        byCall.set(entry.toolCallId, entry);
      }
    }
    const paired = new Set<string>();
    for (const entry of entries) {
      if ((entry.kind === "tool_call" || entry.kind === "approval_request") && entry.toolCallId) {
        const match = byCall.get(entry.toolCallId);
        if (match) paired.add(match.id);
      }
    }
    return { returnByCall: byCall, pairedReturnIds: paired };
  }, [entries]);

  return (
    <div className="messages-wrap">
      <div className="messages" ref={containerRef}>
        {entries.length === 0 && !processing ? (
          <p className="muted empty">No messages yet. Say something below.</p>
        ) : null}

        {entries.map((entry) => {
          // A tool call and its result render as one block: skip the standalone
          // return when it has a matching call, and hand the call its return.
          if (entry.kind === "tool_return" && entry.toolCallId && pairedReturnIds.has(entry.id)) {
            return null;
          }
          const retn =
            (entry.kind === "tool_call" || entry.kind === "approval_request") && entry.toolCallId
              ? (returnByCall.get(entry.toolCallId) ?? null)
              : null;
          return (
            <MessageItem
              key={entry.id}
              entry={entry}
              retn={retn}
              cwd={cwd}
              fileLinks={fileLinks}
              onOpenFile={onOpenFile}
            />
          );
        })}

        {processing ? (
          <div className="entry working">
            <span className="dot" /> <span className="dot" /> <span className="dot" />
          </div>
        ) : null}
      </div>

      {!stuck ? (
        <button
          type="button"
          className="jump"
          onClick={() => {
            setStuck(true);
            const container = containerRef.current;
            if (container) container.scrollTop = container.scrollHeight;
          }}
        >
          <Icon name="arrow-down" /> Latest
        </button>
      ) : null}
    </div>
  );
}

/**
 * Memoised. A streamed token re-renders the list, and without this every
 * message in a long conversation would re-parse its markdown per token.
 * `sortedEntries` shallow-copies the still-streaming entries so the one row
 * that is actually changing has a new identity and does re-render.
 */
const MessageItem = memo(function MessageItem({
  entry,
  retn,
  cwd,
  fileLinks,
  onOpenFile,
}: {
  entry: TranscriptEntry;
  /** For a tool call: its matching return, folded into the same block. */
  retn?: TranscriptEntry | null;
  cwd: string | null;
  fileLinks: FileLinks;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = KIND_LABEL[entry.kind] ?? entry.kind;

  // Look up every filename this entry mentions so `Markdown` can link the real
  // ones. Skipped while the bubble is still streaming — a half-typed name would
  // just fill the miss cache.
  const { note } = fileLinks;
  const scan = !entry.streaming ? entry.text : "";
  useEffect(() => {
    if (!scan) return;
    const tokens = collectFileTokens(scan);
    if (tokens.length > 0) note(tokens);
  }, [scan, note]);

  const md = (text: string) => (
    <Markdown text={text} cwd={cwd} resolve={fileLinks.resolve} onOpenFile={onOpenFile} />
  );

  if (entry.kind === "notice") {
    return (
      <div className={`entry notice ${entry.level ?? "info"}${entry.dim ? " dim" : ""}`}>
        <pre>{entry.text}</pre>
        {/* The provider's raw payload, kept reachable but out of the way — it
            names the real fault often enough to be worth one tap. */}
        {entry.detail ? (
          <>
            <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
              <span className="tag">Details</span>
              <Icon name={open ? "chevron-down" : "chevron-right"} className="chevron" />
            </button>
            {open ? <pre className="tool-args">{entry.detail}</pre> : null}
          </>
        ) : null}
      </div>
    );
  }

  if (entry.kind === "tool_call" || entry.kind === "approval_request") {
    const args = formatArgs(entry.toolArgs);
    // Mid-stream the argument JSON is truncated and unparseable, so the summary
    // is absent until the call is whole; the raw args carry the preview until then.
    const summary = summarizeToolCall(entry.toolName, parseToolArgs(entry.toolArgs), cwd);
    const inPreview = summary?.headline || firstLine(entry.toolArgs);
    // `retn` is the folded return; null means it has not arrived yet.
    const status = retn?.status ?? null;
    const outText = retn?.text ?? "";
    const stderr = retn?.stderr?.join("\n") ?? "";
    const showStderr = stderr.length > 0 && !outText.includes(stderr);
    const outPreview = firstLine(outText) || (showStderr ? firstLine(stderr) : "");
    const hasBody = Boolean(args) || Boolean(outText) || showStderr;
    return (
      <div className={`entry tool${status === "error" ? " error" : ""}`}>
        <button
          type="button"
          className="tool-head"
          onClick={() => setOpen((v) => !v)}
          disabled={!hasBody}
        >
          <code>{entry.toolName ?? "…"}</code>
          {inPreview ? (
            <span className={`grow-text summary${(summary?.mono ?? true) ? " mono" : ""}`}>
              {clip(inPreview, 200)}
            </span>
          ) : null}
          {status === "error" ? <span className="tag bad">error</span> : null}
          {hasBody ? (
            <Icon name={open ? "chevron-down" : "chevron-right"} className="chevron" />
          ) : null}
        </button>
        {summary?.subtitle ? <p className="tool-subtitle">{summary.subtitle}</p> : null}
        {open ? (
          <div className="rail">
            {args ? <span className="rail-label">IN</span> : null}
            {args ? <pre className="tool-args">{args}</pre> : null}
            {outText || showStderr ? <span className="rail-label">OUT</span> : null}
            {outText ? <pre className="tool-args">{outText}</pre> : null}
            {showStderr ? <pre className="tool-args stderr">{stderr}</pre> : null}
            {!retn ? <span className="tool-peek">Running…</span> : null}
          </div>
        ) : outPreview ? (
          <div className="rail peek">
            <span className="rail-label">OUT</span>
            <span className="tool-peek">{clip(outPreview, 200)}</span>
          </div>
        ) : !retn ? (
          <div className="rail peek">
            <span className="tool-peek">Running…</span>
          </div>
        ) : null}
      </div>
    );
  }

  if (entry.kind === "tool_return") {
    // stdout and stderr arrive separately on the running snapshot but not on
    // the canonical frame that replaces it, so `text` is the reliable body and
    // the streams are only shown when they add something it does not carry.
    const stderr = entry.stderr?.join("\n") ?? "";
    const showStderr = stderr.length > 0 && !entry.text.includes(stderr);
    const long = entry.text.length > 400;
    const shown = open || !long ? entry.text : `${entry.text.slice(0, 400)}…`;
    return (
      <div className={`entry tool_return ${entry.status ?? "success"}`}>
        <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
          <span className="tag">{label}</span>
          {entry.toolName ? <code>{entry.toolName}</code> : null}
          {entry.status === "error" ? <span className="tag bad">error</span> : null}
          {long ? (
            <Icon name={open ? "chevron-down" : "chevron-right"} className="chevron" />
          ) : null}
        </button>
        {shown || showStderr ? (
          <div className="rail">
            <span className="rail-label">OUT</span>
            {shown ? <pre className="tool-args">{shown}</pre> : null}
            {showStderr ? <pre className="tool-args stderr">{stderr}</pre> : null}
          </div>
        ) : null}
      </div>
    );
  }

  if (entry.kind === "reasoning") {
    return (
      <div className="entry reasoning">
        <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
          <span className="muted small">Thinking</span>
          <Icon name={open ? "chevron-down" : "chevron-right"} className="chevron" />
        </button>
        {open ? <div className="bubble thinking">{md(entry.text)}</div> : null}
      </div>
    );
  }

  if (entry.kind === "task") {
    // Header always readable — what finished and whether it worked — with the
    // result body (genuine markdown) behind the same disclosure tool output uses.
    const hasResult = entry.text.trim().length > 0;
    return (
      <div className="entry task">
        <button
          type="button"
          className="tool-head"
          onClick={() => setOpen((v) => !v)}
          disabled={!hasResult}
        >
          <Icon name="task" />
          <span className="tag">Task</span>
          {entry.status ? (
            <span className={`tag${entry.status === "error" ? " bad" : " ok-tag"}`}>
              {entry.status === "error" ? "failed" : "completed"}
            </span>
          ) : null}
          <span className="grow-text">{entry.title ?? ""}</span>
          {hasResult ? (
            <Icon name={open ? "chevron-down" : "chevron-right"} className="chevron" />
          ) : null}
        </button>
        {open && hasResult ? <div className="bubble task-result">{md(entry.text)}</div> : null}
      </div>
    );
  }

  if (entry.reminder) {
    // Machine payload, not prose: shown verbatim rather than through Markdown,
    // which would swallow the tags and the paragraph after them.
    return (
      <div className="entry system reminder">
        <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
          <span className="tag">System reminder</span>
          <Icon name={open ? "chevron-down" : "chevron-right"} className="chevron" />
        </button>
        {open ? <pre className="tool-args">{entry.text}</pre> : null}
      </div>
    );
  }

  return (
    <div className={`entry ${entry.kind}`}>
      {entry.kind !== "user" ? <span className="tag">{label}</span> : null}
      {/* Arrived from Telegram/Slack rather than typed here — still you. */}
      {entry.channel ? <span className="tag">via {entry.channel}</span> : null}
      <div className={`bubble ${entry.kind}`}>{md(entry.text)}</div>
    </div>
  );
});
