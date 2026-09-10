import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

  return (
    <div className="messages-wrap">
      <div className="messages" ref={containerRef}>
        {entries.length === 0 && !processing ? (
          <p className="muted empty">No messages yet. Say something below.</p>
        ) : null}

        {entries.map((entry) => (
          <MessageItem
            key={entry.id}
            entry={entry}
            cwd={cwd}
            fileLinks={fileLinks}
            onOpenFile={onOpenFile}
          />
        ))}

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

function MessageItem({
  entry,
  cwd,
  fileLinks,
  onOpenFile,
}: {
  entry: TranscriptEntry;
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
    // is absent until the call is whole; the tool name carries the row until
    // then. The raw JSON stays behind the disclosure either way.
    const summary = summarizeToolCall(entry.toolName, parseToolArgs(entry.toolArgs), cwd);
    return (
      <div className={`entry ${entry.kind}`}>
        <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
          <span className="tag">{label}</span>
          <code>{entry.toolName ?? "…"}</code>
          {summary ? (
            <span className={`grow-text summary${summary.mono ? " mono" : ""}`}>
              {summary.headline}
            </span>
          ) : null}
          {args ? (
            <Icon name={open ? "chevron-down" : "chevron-right"} className="chevron" />
          ) : null}
        </button>
        {summary?.subtitle ? <p className="tool-subtitle">{summary.subtitle}</p> : null}
        {open && args ? <pre className="tool-args">{args}</pre> : null}
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
        {shown ? <pre className="tool-args">{shown}</pre> : null}
        {showStderr ? <pre className="tool-args stderr">{stderr}</pre> : null}
      </div>
    );
  }

  if (entry.kind === "reasoning") {
    return (
      <div className="entry reasoning">
        <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
          <span className="tag">{label}</span>
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
      <div className={`bubble ${entry.kind}`}>
        {md(entry.text)}
        {entry.streaming ? <span className="caret" /> : null}
      </div>
    </div>
  );
}
