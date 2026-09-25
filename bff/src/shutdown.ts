import type { ActiveScope } from "./session/activity.ts";

/** How often the drain re-checks the active set. */
export const DRAIN_POLL_MS = 1000;
/** How often a long drain says it is still waiting. */
export const DRAIN_LOG_EVERY_MS = 30_000;

export interface DrainOptions {
  /** The conversations with a turn in progress right now. */
  activeScopes: () => ActiveScope[];
  timeoutMs: number;
  log: (message: string) => void;
  /** Resolves early when the operator asks again — a second signal. */
  interrupted: Promise<void>;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  logEveryMs?: number;
}

export type DrainResult = "idle" | "drained" | "timed_out" | "interrupted";

/**
 * Wait for in-flight turns to finish before the upstream connection closes.
 *
 * Closing the BFF's upstream socket is not a quiet disconnect: it is the only
 * subscribed connection for every scope, so `cleanupListenerConnection` cancels
 * each running turn. Cancellation cannot reach llama.cpp, so the backend run
 * keeps going, and the next BFF's owner sync then re-sends the interrupted tool
 * calls into a conversation that is still busy. That send waits out
 * `BUSY_RUN_WAIT_TIMEOUT_MS` (5 min) and ends the turn with "Conversation is
 * still busy because run … remained active" — a deploy that looked harmless
 * turns into an error push five minutes later. Waiting here is what keeps a
 * `bff` redeploy from killing a cron turn mid-flight.
 *
 * Bounded by `timeoutMs` so a deploy cannot hang forever on a turn that never
 * ends (or one parked on an approval nobody answers — `is_processing` stays
 * true there too).
 */
export async function drainActiveTurns(options: DrainOptions): Promise<DrainResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = options.pollMs ?? DRAIN_POLL_MS;
  const logEveryMs = options.logEveryMs ?? DRAIN_LOG_EVERY_MS;

  let interrupted = false;
  void options.interrupted.then(() => {
    interrupted = true;
  });

  let active = options.activeScopes();
  if (active.length === 0) return "idle";

  const startedAt = now();
  let lastLogAt = Number.NEGATIVE_INFINITY;
  while (active.length > 0) {
    const elapsed = now() - startedAt;
    if (elapsed >= options.timeoutMs) {
      options.log(
        `Drain timed out after ${Math.round(elapsed / 1000)}s; abandoning ${describe(active)}`,
      );
      return "timed_out";
    }
    if (now() - lastLogAt >= logEveryMs) {
      lastLogAt = now();
      options.log(
        `Draining before shutdown: waiting on ${describe(active)} ` +
          `(${Math.round((options.timeoutMs - elapsed) / 1000)}s left; signal again to stop now)`,
      );
    }
    await Promise.race([sleep(pollMs), options.interrupted]);
    if (interrupted) {
      options.log(`Drain interrupted; abandoning ${describe(options.activeScopes())}`);
      return "interrupted";
    }
    active = options.activeScopes();
  }
  options.log("Drained: no turn in progress");
  return "drained";
}

function describe(scopes: ActiveScope[]): string {
  const names = scopes.map((s) => `${s.agent_id}/${s.conversation_id}`).join(", ");
  return `${scopes.length} active turn(s): ${names}`;
}
