import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "../lib/messages.ts";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";

interface Props {
  entries: TranscriptEntry[];
  processing: boolean;
}

const KIND_LABEL: Record<string, string> = {
  user: "You",
  assistant: "Agent",
  reasoning: "Thinking",
  tool_call: "Tool",
  tool_return: "Result",
  system: "System",
  task: "Task",
  approval_request: "Approval",
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

export function MessageList({ entries, processing }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
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
          <MessageItem key={entry.id} entry={entry} />
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

function MessageItem({ entry }: { entry: TranscriptEntry }) {
  const [open, setOpen] = useState(false);
  const label = KIND_LABEL[entry.kind] ?? entry.kind;

  if (entry.kind === "notice") {
    return (
      <div className={`entry notice ${entry.level ?? "info"}${entry.dim ? " dim" : ""}`}>
        <pre>{entry.text}</pre>
      </div>
    );
  }

  if (entry.kind === "tool_call" || entry.kind === "approval_request") {
    const args = formatArgs(entry.toolArgs);
    return (
      <div className={`entry ${entry.kind}`}>
        <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
          <span className="tag">{label}</span>
          <code>{entry.toolName ?? "…"}</code>
          {args ? (
            <Icon name={open ? "chevron-down" : "chevron-right"} className="chevron" />
          ) : null}
        </button>
        {open && args ? <pre className="tool-args">{args}</pre> : null}
      </div>
    );
  }

  if (entry.kind === "tool_return") {
    const long = entry.text.length > 400;
    const shown = open || !long ? entry.text : `${entry.text.slice(0, 400)}…`;
    return (
      <div className={`entry tool_return ${entry.status ?? "success"}`}>
        <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
          <span className="tag">{label}</span>
          {entry.status === "error" ? <span className="tag bad">error</span> : null}
          {long ? (
            <Icon name={open ? "chevron-down" : "chevron-right"} className="chevron" />
          ) : null}
        </button>
        <pre className="tool-args">{shown}</pre>
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
        {open ? (
          <div className="bubble thinking">
            <Markdown text={entry.text} />
          </div>
        ) : null}
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
        {open && hasResult ? (
          <div className="bubble task-result">
            <Markdown text={entry.text} />
          </div>
        ) : null}
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
        <Markdown text={entry.text} />
        {entry.streaming ? <span className="caret" /> : null}
      </div>
    </div>
  );
}
