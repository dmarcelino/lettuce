import { useState } from "react";
import { contextGauge, formatTokens, percentOf, type TurnUsage } from "../lib/usage.ts";
import {
  type ContextLimit,
  LETTA_DEFAULT_CONTEXT_LIMIT,
  MIN_CONTEXT_LIMIT,
  parseContextLimit,
} from "../state/use-context-limit.ts";
import { Icon } from "./Icon.tsx";
import { Sheet } from "./Sheet.tsx";

/**
 * How full the conversation's context is, in the top bar: "25k / 128k" over a
 * thin bar, amber from 80% — where Letta starts to think about summarising.
 * Absent until a turn has reported usage (live or remembered).
 */
export function ContextGauge({
  usage,
  limit,
  onOpen,
}: {
  usage: TurnUsage | null;
  limit: ContextLimit | null;
  onOpen: () => void;
}) {
  if (usage?.contextTokens === undefined || !limit) return null;
  const gauge = contextGauge(usage.contextTokens, limit.tokens);
  return (
    <button
      type="button"
      className={`ctx-gauge${gauge.warn ? " warn" : ""}`}
      onClick={onOpen}
      aria-label={`Context: ${usage.contextTokens.toLocaleString()} of ${limit.tokens.toLocaleString()} tokens, ${gauge.percent}% full`}
      title={`${gauge.percent}% of the context window`}
    >
      <span className="ctx-gauge-label">{gauge.label}</span>
      <span className="ctx-bar" aria-hidden="true">
        <i style={{ width: `${gauge.percent}%` }} />
      </span>
    </button>
  );
}

const PRESETS: { label: string; tokens: number | null }[] = [
  { label: "128k", tokens: 131_072 },
  { label: "256k", tokens: 262_144 },
  { label: `Default (${formatTokens(LETTA_DEFAULT_CONTEXT_LIMIT)})`, tokens: null },
];

function sourceLabel(limit: ContextLimit, agentName: string | null): string {
  if (limit.source === "conversation") return "set for this conversation";
  if (limit.tokens === LETTA_DEFAULT_CONTEXT_LIMIT) return "letta-code default";
  return agentName ? `set for ${agentName}` : "set for this agent";
}

/**
 * The gauge's details: context against the limit, the last turn's usage, and
 * the limit itself — tap it to change it for this conversation or the agent.
 */
export function ContextSheet({
  usage,
  limit,
  agentName,
  processing,
  onApply,
  onClose,
}: {
  usage: TurnUsage | null;
  limit: ContextLimit | null;
  agentName: string | null;
  processing: boolean;
  onApply: (tokens: number | null, scope: "conversation" | "agent") => Promise<string>;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [reset, setReset] = useState(false);
  const [scope, setScope] = useState<"conversation" | "agent">("agent");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const used = usage?.contextTokens;
  const gauge = used !== undefined && limit ? contextGauge(used, limit.tokens) : null;

  const startEditing = () => {
    setText(limit ? limit.tokens.toLocaleString() : "");
    setReset(false);
    setScope(limit?.source === "conversation" ? "conversation" : "agent");
    setMessage(null);
    setEditing(true);
  };

  const parsed = reset ? null : parseContextLimit(text);
  const invalid =
    !reset &&
    (parsed === null
      ? "Enter a number of tokens, e.g. 262144 or 256k"
      : parsed < MIN_CONTEXT_LIMIT
        ? `At least ${MIN_CONTEXT_LIMIT.toLocaleString()} tokens`
        : null);

  const save = async () => {
    if (invalid) return;
    setBusy(true);
    setMessage(null);
    try {
      const output = await onApply(reset ? null : parsed, scope);
      setMessage({ tone: "ok", text: output || "Context limit updated" });
      setEditing(false);
    } catch (error) {
      setMessage({ tone: "bad", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Context" onClose={onClose}>
      {gauge && used !== undefined && limit ? (
        <>
          <div className="ctx-big">
            <span>
              <b>{used.toLocaleString()}</b> of {limit.tokens.toLocaleString()}
            </span>
            <span className={gauge.warn ? "warn" : ""}>{gauge.percent}% full</span>
          </div>
          <div className={`ctx-bar big${gauge.warn ? " warn" : ""}`} aria-hidden="true">
            <i style={{ width: `${gauge.percent}%` }} />
          </div>
        </>
      ) : null}
      <p className="menu-intro">
        Letta summarises the conversation when it gets close to the limit.
      </p>

      {usage ? (
        <>
          <p className="menu-section">{processing ? "This turn so far" : "Last turn"}</p>
          <ul className="kv-list">
            <li>
              <span>Prompt</span>
              <span>
                {usage.lastPromptTokens.toLocaleString()} <small>· last call</small>
              </span>
            </li>
            {usage.cacheReported ? (
              <li>
                <span>Cache hit</span>
                <span>
                  {usage.lastCachedTokens.toLocaleString()}{" "}
                  <small>
                    · {percentOf(usage.lastCachedTokens, usage.lastPromptTokens)}% of prompt
                  </small>
                </span>
              </li>
            ) : null}
            <li>
              <span>Generated</span>
              <span>
                {usage.completionTokens.toLocaleString()}
                {usage.reasoningTokens > 0 ? (
                  <small> · {usage.reasoningTokens.toLocaleString()} thinking</small>
                ) : null}
              </span>
            </li>
            <li>
              <span>Model calls (steps)</span>
              <span>{usage.steps}</span>
            </li>
            <li>
              <span>Input processed</span>
              <span>
                {usage.promptTokens.toLocaleString()}{" "}
                <small>· {usage.cacheReported ? "evaluated, all calls" : "all calls"}</small>
              </span>
            </li>
            {usage.cacheReported ? (
              <li>
                <span>From cache</span>
                <span>
                  {usage.cachedTokens.toLocaleString()} <small>· all calls</small>
                </span>
              </li>
            ) : null}
          </ul>
        </>
      ) : null}

      <p className="menu-section">Limit</p>
      {!editing ? (
        <>
          <ul className="kv-list">
            <li>
              <button type="button" className="kv-tap" onClick={startEditing} disabled={!limit}>
                <span>{limit ? `${limit.tokens.toLocaleString()} tokens` : "Loading…"}</span>
                <span>
                  {limit ? <small>{sourceLabel(limit, agentName)}</small> : null}
                  <Icon name="chevron-right" />
                </span>
              </button>
            </li>
          </ul>
          {message ? (
            <p className={`small ${message.tone === "ok" ? "ok" : "bad"} ctx-message`}>
              {message.text}
            </p>
          ) : (
            <p className="ctx-hint">Tap to change the limit for this conversation or the agent.</p>
          )}
        </>
      ) : (
        <div className="limit-edit">
          <input
            type="text"
            inputMode="numeric"
            value={reset ? `${LETTA_DEFAULT_CONTEXT_LIMIT.toLocaleString()} (default)` : text}
            onChange={(event) => {
              setReset(false);
              setText(event.target.value);
            }}
            aria-label="Context limit in tokens"
          />
          <div className="limit-presets">
            {PRESETS.map((preset) => {
              const on = preset.tokens === null ? reset : !reset && parsed === preset.tokens;
              return (
                <button
                  key={preset.label}
                  type="button"
                  className={`limit-preset${on ? " on" : ""}`}
                  onClick={() => {
                    if (preset.tokens === null) setReset(true);
                    else {
                      setReset(false);
                      setText(preset.tokens.toLocaleString());
                    }
                  }}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          <ul className="menu-list">
            <li>
              <button
                type="button"
                className={`menu-row${scope === "conversation" ? " selected" : ""}`}
                onClick={() => setScope("conversation")}
                aria-pressed={scope === "conversation"}
              >
                <span className="menu-row-text">
                  <span className="menu-row-title">This conversation only</span>
                </span>
                {scope === "conversation" ? <Icon name="check" className="menu-row-check" /> : null}
              </button>
            </li>
            <li>
              <button
                type="button"
                className={`menu-row${scope === "agent" ? " selected" : ""}`}
                onClick={() => setScope("agent")}
                aria-pressed={scope === "agent"}
              >
                <span className="menu-row-text">
                  <span className="menu-row-title">
                    All of {agentName ?? "this agent"}&apos;s conversations
                  </span>
                </span>
                {scope === "agent" ? <Icon name="check" className="menu-row-check" /> : null}
              </button>
            </li>
          </ul>
          {scope === "agent" && limit?.source === "conversation" ? (
            <p className="ctx-hint">
              This conversation has its own limit ({limit.tokens.toLocaleString()}), which still
              applies here.
            </p>
          ) : null}
          <p className="limit-warning">
            Keep this at or below the context your server gives each request (llama.cpp: n_ctx per
            slot), or requests will fail instead of being summarised.
          </p>
          {invalid ? <p className="small bad">{invalid}</p> : null}
          {message?.tone === "bad" ? <p className="small bad">{message.text}</p> : null}
          <div className="limit-actions">
            <button
              type="button"
              className="button ghost"
              onClick={() => setEditing(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button"
              onClick={() => void save()}
              disabled={busy || invalid !== null}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
