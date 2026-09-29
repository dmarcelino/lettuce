import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { frameScopeKey } from "./buffer.ts";

/**
 * Token usage for one agent turn, as served to the web client
 * (`web/src/lib/usage.ts` reads this exact shape; the packages cannot share
 * code).
 *
 * The prompt is split the way the model server reports it. letta-code's local
 * executor (pi-ai `parseChunkUsage`) sends `prompt_tokens` **net of the cache**
 * and the reused part as `cached_input_tokens` — on llama.cpp that is the slot's
 * prompt cache. So a 85k-token call that reused 84k of its prefix arrives as
 * `prompt_tokens: 790`. Cache writes are counted as evaluated, because they
 * were.
 */
export interface TurnUsage {
  /** Prompt tokens the model actually evaluated, summed over every step. */
  promptTokens: number;
  /** Prompt tokens served from the prompt cache, summed over every step. */
  cachedTokens: number;
  /** The latest step's whole prompt — evaluated plus cached. */
  lastPromptTokens: number;
  /** Of `lastPromptTokens`, the part served from the cache. */
  lastCachedTokens: number;
  /** Whether the backend reported cache use at all (absent is not zero). */
  cacheReported: boolean;
  completionTokens: number;
  /** Of `completionTokens`, the thinking part, when the model reports it. */
  reasoningTokens: number;
  /** Model calls in the turn; each tool round-trip is another step. */
  steps: number;
  /** Context window occupancy after the latest step, when reported. */
  contextTokens?: number;
}

export interface TurnUsageRecord extends TurnUsage {
  turn_id: string | null;
  /** When the BFF saw the turn end. */
  at: string;
}

/** Conversations remembered at once; the least recently active is dropped first. */
export const TURN_USAGE_SCOPES = 200;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * One `usage_statistics` delta (or the listener's `UsageStatistics` shape) as
 * a `TurnUsage`, or null for anything else.
 */
export function readUsageStatistics(raw: unknown): TurnUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const cacheReported =
    typeof u.cached_input_tokens === "number" || typeof u.cache_write_tokens === "number";
  const evaluated = count(u.prompt_tokens) + count(u.cache_write_tokens);
  const cached = count(u.cached_input_tokens);
  const usage: TurnUsage = {
    promptTokens: evaluated,
    cachedTokens: cached,
    lastPromptTokens: evaluated + cached,
    lastCachedTokens: cached,
    cacheReported,
    completionTokens: count(u.completion_tokens),
    reasoningTokens: count(u.reasoning_tokens),
    // One chunk is one step unless it says otherwise.
    steps: typeof u.step_count === "number" ? count(u.step_count) : 1,
  };
  if (typeof u.context_tokens === "number") usage.contextTokens = u.context_tokens;
  return usage;
}

/** Fold one step into a running turn total. Context is a level, not a sum: the latest wins. */
export function addUsage(total: TurnUsage | null, step: TurnUsage): TurnUsage {
  if (!total) return { ...step };
  const next: TurnUsage = {
    promptTokens: total.promptTokens + step.promptTokens,
    cachedTokens: total.cachedTokens + step.cachedTokens,
    lastPromptTokens: step.lastPromptTokens,
    lastCachedTokens: step.lastCachedTokens,
    cacheReported: total.cacheReported || step.cacheReported,
    completionTokens: total.completionTokens + step.completionTokens,
    reasoningTokens: total.reasoningTokens + step.reasoningTokens,
    steps: total.steps + step.steps,
  };
  const context = step.contextTokens ?? total.contextTokens;
  if (context !== undefined) next.contextTokens = context;
  return next;
}

/**
 * The last finished turn's usage, and the turn in flight so far, per
 * conversation — so every device shows the same numbers.
 *
 * Upstream reports usage only live: one `usage_statistics` stream delta per
 * model step, and `turn_finished.usage` only when the conversation carries CLI
 * `execution_settings` (which we never set). Nothing is stored with the
 * history. When browsers kept it, each showed the last turn *it* happened to
 * watch — a phone that slept through three turns showed the context of the
 * fourth-last one. The BFF sees every scope's frames on its permanent
 * connection, so it keeps them here.
 *
 * Subagent deltas share the parent's scope (with `subagent_id`); they are not
 * the parent's model calls and are skipped. In memory only: a BFF restart
 * forgets it until the next turn.
 */
export class TurnUsageLog {
  private readonly scopes = new Map<
    string,
    { last: TurnUsageRecord | null; current: TurnUsage | null }
  >();

  constructor(private readonly now: () => Date = () => new Date()) {}

  observe(frame: WsProtocolMessage): void {
    if (frame.type === "stream_delta") {
      if ((frame as { subagent_id?: unknown }).subagent_id) return;
      const delta = (frame as { delta?: unknown }).delta as { message_type?: unknown } | undefined;
      if (delta?.message_type !== "usage_statistics") return;
      const step = readUsageStatistics(delta);
      const key = frameScopeKey(frame);
      if (!step || !key) return;
      const entry = this.touch(key);
      entry.current = addUsage(entry.current, step);
      return;
    }
    if (frame.type !== "turn_finished") return;
    const key = frameScopeKey(frame);
    if (!key) return;
    const entry = this.touch(key);
    const folded = entry.current;
    entry.current = null;
    const reported = readUsageStatistics((frame as { usage?: unknown }).usage);
    const usage = reported ? mergeReported(folded, reported) : folded;
    if (!usage) return;
    entry.last = {
      ...usage,
      turn_id: typeof frame.turn_id === "string" ? frame.turn_id : null,
      at: this.now().toISOString(),
    };
  }

  get(scopeKey: string): { last: TurnUsageRecord | null; current: TurnUsage | null } {
    const entry = this.scopes.get(scopeKey);
    return { last: entry?.last ?? null, current: entry?.current ?? null };
  }

  private touch(key: string): { last: TurnUsageRecord | null; current: TurnUsage | null } {
    const entry = this.scopes.get(key) ?? { last: null, current: null };
    // Re-insert so Map order tracks recency; the oldest scope is evicted first.
    this.scopes.delete(key);
    this.scopes.set(key, entry);
    if (this.scopes.size > TURN_USAGE_SCOPES) {
      const oldest = this.scopes.keys().next().value;
      if (oldest !== undefined) this.scopes.delete(oldest);
    }
    return entry;
  }
}

/**
 * `turn_finished.usage` is the authoritative total, but it has no per-step
 * view, so the latest step's prompt comes from the fold when there is one.
 */
function mergeReported(folded: TurnUsage | null, reported: TurnUsage): TurnUsage {
  if (!folded) return reported;
  const merged: TurnUsage = {
    ...reported,
    lastPromptTokens: folded.lastPromptTokens,
    lastCachedTokens: folded.lastCachedTokens,
    cacheReported: reported.cacheReported || folded.cacheReported,
  };
  const context = reported.contextTokens ?? folded.contextTokens;
  if (context !== undefined) merged.contextTokens = context;
  return merged;
}
