/**
 * Token usage for one agent turn.
 *
 * The source is the `usage_statistics` stream delta: the local executor emits
 * one per model step (letta-code: backend/dev/provider-turn-executor.ts), and
 * the listener forwards it to every subscriber like any other chunk. It has no
 * `id`, so the transcript never keys it — this module is its only consumer.
 *
 * `turn_finished.usage` (letta-code 0.32.19) would be the obvious source, but
 * the listener attaches it only when the conversation carries CLI
 * `execution_settings` (listener/turn.ts), and setting those to get it would
 * strip `MEMORY_DIR` from agent shells and impose tool allowlists. It is still
 * honoured when present, as the authoritative total.
 */
export interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
  /** Model calls in the turn; each tool round-trip is another step. */
  steps: number;
  /** Context window occupancy after the latest step, when the backend reports it. */
  contextTokens?: number;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The usage carried by one `usage_statistics` delta, or null for any other delta. */
export function readUsageDelta(delta: unknown): TurnUsage | null {
  if (!delta || typeof delta !== "object") return null;
  const raw = delta as Record<string, unknown>;
  if (raw.message_type !== "usage_statistics") return null;
  const usage: TurnUsage = {
    promptTokens: count(raw.prompt_tokens),
    completionTokens: count(raw.completion_tokens),
    // One chunk is one step unless it says otherwise.
    steps: typeof raw.step_count === "number" ? count(raw.step_count) : 1,
  };
  if (typeof raw.context_tokens === "number") usage.contextTokens = raw.context_tokens;
  return usage;
}

/** `turn_finished.usage`, in the listener's `UsageStatistics` shape, or null when absent. */
export function readTurnFinishedUsage(frame: unknown): TurnUsage | null {
  if (!frame || typeof frame !== "object") return null;
  const usage = (frame as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  return readUsageDelta({ ...usage, message_type: "usage_statistics" });
}

/** Fold one step into a running turn total. Context is a level, not a sum: the latest wins. */
export function addUsage(total: TurnUsage | null, step: TurnUsage): TurnUsage {
  if (!total) return { ...step };
  const next: TurnUsage = {
    promptTokens: total.promptTokens + step.promptTokens,
    completionTokens: total.completionTokens + step.completionTokens,
    steps: total.steps + step.steps,
  };
  const context = step.contextTokens ?? total.contextTokens;
  if (context !== undefined) next.contextTokens = context;
  return next;
}

/** 950 → "950", 12_345 → "12.3k", 1_234_567 → "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** The short readout for the composer row: output tokens, plus context when known. */
export function usageLabel(usage: TurnUsage): string {
  const out = `↓${formatTokens(usage.completionTokens)}`;
  return usage.contextTokens !== undefined
    ? `${formatTokens(usage.contextTokens)} ctx · ${out}`
    : out;
}

/** The full breakdown, for the tooltip and accessible name. */
export function usageDescription(usage: TurnUsage): string {
  const parts = [
    `Last turn: ${usage.promptTokens.toLocaleString()} prompt tokens`,
    `${usage.completionTokens.toLocaleString()} generated`,
    `${usage.steps} ${usage.steps === 1 ? "step" : "steps"}`,
  ];
  if (usage.contextTokens !== undefined) {
    parts.push(`${usage.contextTokens.toLocaleString()} tokens in context`);
  }
  return parts.join(", ");
}
