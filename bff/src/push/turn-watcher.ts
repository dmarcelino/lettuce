import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { frameScopeKey, parseScopeKey } from "../session/buffer.ts";
import type { AgentNames } from "./agent-names.ts";
import { conversationUrl, notify as defaultNotify, type PushEventType } from "./notify.ts";
import type { PushSubscriptionStore } from "./store.ts";

/** Quiet time after the last turn before the agent counts as done. */
export const SETTLE_MS = 5_000;
/** Longest a finished turn waits on follow-up work before it is reported anyway. */
export const MAX_HOLD_MS = 30 * 60_000;

/** Longest error excerpt a push carries; notification UIs clip long bodies anyway. */
export const PUSH_ERROR_EXCERPT_CHARS = 120;

export interface Clock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface ScopeState {
  processing: boolean;
  /** Queued items that will run on their own (paused ones wait for the user). */
  queued: number;
  /** Subagents launched from this conversation that have not finished. */
  subagents: number;
  /** The latest finished turn, waiting for the conversation to go quiet. */
  outcome: { error?: string; since: number } | null;
  timer: unknown;
}

/**
 * Pushes once the agent is actually DONE with a conversation — not at the end
 * of every turn — and only while nobody is watching it.
 *
 * One request routinely spans several turns: a queued message runs right after
 * the first, and a background subagent reports back later as a task
 * notification that starts a turn of its own. `turn_finished` fires for each,
 * so pushing on it announced "finished" while the agent was still working, and
 * then again. Instead a finished turn is held until the conversation has had
 * nothing running, nothing queued and no subagent in flight for `SETTLE_MS`,
 * and the push reports the LAST turn's outcome. A hold is capped at
 * `MAX_HOLD_MS`, so a subagent that never finishes cannot swallow the push.
 * Whether anyone is watching is decided when the push is due, not when the
 * first turn ended.
 */
export class TurnOutcomeWatcher {
  private readonly scopes = new Map<string, ScopeState>();
  private isWatched: (scopeKey: string) => boolean = () => false;

  constructor(
    private readonly store: PushSubscriptionStore,
    private readonly log: (message: string) => void,
    private readonly names: Pick<AgentNames, "name"> | null = null,
    /** Injectable for tests; defaults to the real push funnel. */
    private readonly notify: typeof defaultNotify = defaultNotify,
    private readonly clock: Clock = REAL_CLOCK,
  ) {}

  observe(frame: WsProtocolMessage, isWatched: (scopeKey: string) => boolean): void {
    this.isWatched = isWatched;
    const key = frameScopeKey(frame);
    if (!key) return;

    const raw = frame as unknown as Record<string, unknown>;
    switch (frame.type) {
      case "update_device_status": {
        const status = raw.device_status as { is_processing?: unknown } | undefined;
        this.state(key).processing = status?.is_processing === true;
        break;
      }
      case "update_queue": {
        const queue = Array.isArray(raw.queue) ? (raw.queue as { paused?: unknown }[]) : [];
        this.state(key).queued = queue.filter((item) => item.paused !== true).length;
        break;
      }
      case "update_subagent_state": {
        const list = Array.isArray(raw.subagents) ? (raw.subagents as { status?: unknown }[]) : [];
        this.state(key).subagents = list.filter(
          (s) => s.status === "pending" || s.status === "running",
        ).length;
        break;
      }
      case "turn_finished": {
        const state = this.state(key);
        state.processing = false;
        state.outcome = {
          ...(frame.error ? { error: frame.error } : {}),
          since: state.outcome?.since ?? this.clock.now(),
        };
        break;
      }
      default:
        return;
    }
    this.reconsider(key);
  }

  private state(key: string): ScopeState {
    let state = this.scopes.get(key);
    if (!state) {
      state = { processing: false, queued: 0, subagents: 0, outcome: null, timer: null };
      this.scopes.set(key, state);
    }
    return state;
  }

  private busy(state: ScopeState): boolean {
    return state.processing || state.queued > 0 || state.subagents > 0;
  }

  /** (Re)arm the push for a scope with a finished turn waiting. */
  private reconsider(key: string): void {
    const state = this.scopes.get(key);
    if (!state?.outcome) return;
    if (state.timer !== null) this.clock.clearTimeout(state.timer);
    const held = this.clock.now() - state.outcome.since;
    const delay = this.busy(state) ? Math.max(0, MAX_HOLD_MS - held) : SETTLE_MS;
    state.timer = this.clock.setTimeout(() => this.due(key), delay);
  }

  private due(key: string): void {
    const state = this.scopes.get(key);
    if (!state?.outcome) return;
    state.timer = null;
    const held = this.clock.now() - state.outcome.since;
    if (this.busy(state) && held < MAX_HOLD_MS) {
      this.reconsider(key);
      return;
    }
    const outcome = state.outcome;
    state.outcome = null;
    if (!this.busy(state)) this.scopes.delete(key);

    if (this.isWatched(key)) {
      // Logged because a suppressed push and a broken one used to look identical
      // from outside: silence either way.
      this.log(`Push for finished turn in ${key} suppressed: a visible session is watching it`);
      return;
    }
    void this.send(key, outcome.error);
  }

  private async send(key: string, error: string | undefined): Promise<void> {
    const [agentId] = parseScopeKey(key);
    const name = (await this.names?.name(agentId)) ?? null;
    const eventType: PushEventType = error ? "failed" : "completed";
    await this.notify(
      this.store,
      {
        title: name ?? "Lettuce",
        body: error ? failureBody(error) : "Finished its turn.",
        url: conversationUrl(key),
      },
      eventType,
      this.log,
    );
  }
}

/**
 * The failure push names the failure. The error is reported nowhere the
 * transcript reloads from (see `session/turn-errors.ts`), so a bare "hit an
 * error" left the notification as the only trace, with nothing in it. Only the
 * first line: a provider error continues with its raw HTTP body.
 */
export function failureBody(error: string): string {
  const firstLine = error.trim().split("\n", 1)[0]?.trim() ?? "";
  if (!firstLine) return "Hit an error.";
  const excerpt =
    firstLine.length > PUSH_ERROR_EXCERPT_CHARS
      ? `${firstLine.slice(0, PUSH_ERROR_EXCERPT_CHARS - 1)}…`
      : firstLine;
  return `Hit an error: ${excerpt}`;
}
