import { useEffect, useRef, useState } from "react";
import {
  type ClaudeRun,
  type ClaudeRunStep,
  fetchClaudeRun,
  formatDuration,
  LIVE_POLL_MS,
  STATUS_LABELS,
} from "../lib/claude.ts";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";
import { Sheet } from "./Sheet.tsx";

interface Props {
  sessionId: string;
  onClose: () => void;
}

function Step({ step }: { step: ClaudeRunStep }) {
  if (step.kind !== "command") {
    if (step.kind === "prompt") {
      return (
        <div className="codex-step codex-prompt">
          <div className="muted small">Task</div>
          <Markdown text={step.text} />
        </div>
      );
    }
    if (step.kind === "reasoning") {
      return <p className="codex-step codex-reasoning muted small">{step.text}</p>;
    }
    return (
      <div className="codex-step">
        <Markdown text={step.text} />
      </div>
    );
  }
  return (
    <details className="codex-step codex-command" open={step.output === null}>
      <summary>
        <Icon name="chevron-right" className="chevron" />
        <code>{step.tool}</code>
        <span className="muted small one-line">{step.input}</span>
        {step.output === null ? <span className="small muted"> running…</span> : null}
      </summary>
      {step.output ? (
        <pre className="tool-args">
          {step.truncated ? "… (earlier output cut)\n" : ""}
          {step.output}
        </pre>
      ) : null}
    </details>
  );
}

/**
 * A Claude Code worker's whole run — every tool call and its output — read
 * from Claude's own transcript via the BFF (letta-code keeps only the final
 * message). Re-reads every few seconds while the run is still going.
 */
export function ClaudeRunSheet({ sessionId, onClose }: Props) {
  const [run, setRun] = useState<ClaudeRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const stepCount = run?.steps.length ?? 0;
  const running = run?.status === "running";

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await fetchClaudeRun(sessionId);
        if (cancelled) return;
        setRun(next);
        setError(null);
        if (next.status === "running") timer = setTimeout(load, LIVE_POLL_MS);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        // A run that has not written its file yet looks like a 404 for a moment.
        timer = setTimeout(load, LIVE_POLL_MS * 2);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  // Follow a live run as it grows; leave a finished one where the reader is.
  useEffect(() => {
    if (running && stepCount > 0) endRef.current?.scrollIntoView({ block: "end" });
  }, [running, stepCount]);

  const facts: string[] = [];
  if (run) {
    facts.push(STATUS_LABELS[run.status]);
    if (run.model) facts.push(run.model);
    if (run.durationMs !== null) facts.push(formatDuration(run.durationMs));
    if (run.usage) {
      facts.push(
        `${run.usage.inputTokens.toLocaleString()} in (${run.usage.cachedInputTokens.toLocaleString()} cached) · ${run.usage.outputTokens.toLocaleString()} out`,
      );
    }
    if (run.cwd) facts.push(run.cwd);
  }

  return (
    <Sheet title="Claude Code run" onClose={onClose} size="spacious" fill status={error}>
      <div className="codex-run">
        {run ? <p className="muted small">{facts.join(" · ")}</p> : null}
        {!run && !error ? <p className="muted">Loading…</p> : null}
        {run?.steps.map((step, index) => (
          <Step key={step.kind === "command" ? step.callId : `${step.kind}-${index}`} step={step} />
        ))}
        {running ? <p className="muted small">Working…</p> : null}
        <div ref={endRef} />
      </div>
    </Sheet>
  );
}
