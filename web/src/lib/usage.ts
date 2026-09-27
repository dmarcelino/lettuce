import { defaultStorage, type MaybeStorage } from "./storage.ts";

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
  /** Prompt tokens summed over every step — the input the model processed. */
  promptTokens: number;
  /** The latest step's prompt alone: how big one call to the model was. */
  lastPromptTokens: number;
  completionTokens: number;
  /** Of `completionTokens`, the thinking part, when the model reports it. */
  reasoningTokens: number;
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
    lastPromptTokens: count(raw.prompt_tokens),
    completionTokens: count(raw.completion_tokens),
    reasoningTokens: count(raw.reasoning_tokens),
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
    lastPromptTokens: step.lastPromptTokens,
    completionTokens: total.completionTokens + step.completionTokens,
    reasoningTokens: total.reasoningTokens + step.reasoningTokens,
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

/** Above this share of the limit the gauge turns amber: compaction is near. */
export const CONTEXT_WARN_RATIO = 0.8;

export interface ContextGauge {
  /** "25k / 128k". */
  label: string;
  /** 0-100, clamped. */
  percent: number;
  warn: boolean;
}

/** How full the context is, for the header gauge and the details panel. */
export function contextGauge(used: number, limit: number): ContextGauge {
  const ratio = limit > 0 ? used / limit : 0;
  return {
    label: `${formatTokens(used)} / ${formatTokens(limit)}`,
    percent: Math.max(0, Math.min(100, Math.round(ratio * 100))),
    warn: ratio >= CONTEXT_WARN_RATIO,
  };
}

const USAGE_KEY = "letta-ui:usage";

/**
 * The last usage seen per conversation, kept per browser. The app-server does
 * not store usage with the history, so without this the gauge vanished on
 * every reload until the next turn finished.
 */
export function readStoredUsage(
  conversationKey: string,
  storage: MaybeStorage = defaultStorage(),
): TurnUsage | null {
  try {
    const all = JSON.parse(storage?.getItem(USAGE_KEY) ?? "{}") as Record<string, unknown>;
    const u = all[conversationKey] as Partial<TurnUsage> | undefined;
    if (!u || typeof u.promptTokens !== "number" || typeof u.completionTokens !== "number") {
      return null;
    }
    return {
      promptTokens: u.promptTokens,
      lastPromptTokens:
        typeof u.lastPromptTokens === "number" ? u.lastPromptTokens : u.promptTokens,
      completionTokens: u.completionTokens,
      reasoningTokens: typeof u.reasoningTokens === "number" ? u.reasoningTokens : 0,
      steps: typeof u.steps === "number" ? u.steps : 1,
      ...(typeof u.contextTokens === "number" ? { contextTokens: u.contextTokens } : {}),
    };
  } catch {
    return null;
  }
}

export function writeStoredUsage(
  conversationKey: string,
  usage: TurnUsage,
  storage: MaybeStorage = defaultStorage(),
): void {
  try {
    const all = JSON.parse(storage?.getItem(USAGE_KEY) ?? "{}") as Record<string, unknown>;
    all[conversationKey] = usage;
    // Bounded: the most recent 50 conversations.
    const keys = Object.keys(all);
    for (const key of keys.slice(0, Math.max(0, keys.length - 50))) delete all[key];
    storage?.setItem(USAGE_KEY, JSON.stringify(all));
  } catch {
    // No memory is fine: the gauge reappears after the next turn.
  }
}
