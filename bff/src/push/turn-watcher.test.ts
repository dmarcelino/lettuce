import { describe, expect, mock, test } from "bun:test";
import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import {
  type Clock,
  failureBody,
  MAX_HOLD_MS,
  PUSH_ERROR_EXCERPT_CHARS,
  SETTLE_MS,
  TurnOutcomeWatcher,
} from "./turn-watcher.ts";

const runtime = { agent_id: "agent-1", conversation_id: "conv-1" };

const finished = (error?: string) =>
  ({
    type: "turn_finished",
    turn_id: "t",
    stop_reason: error ? "error" : "end_turn",
    runtime,
    ...(error ? { error } : {}),
  }) as unknown as WsProtocolMessage;
const processing = (on: boolean) =>
  ({
    type: "update_device_status",
    runtime,
    device_status: { is_processing: on },
  }) as unknown as WsProtocolMessage;
const queue = (items: { paused?: boolean }[]) =>
  ({ type: "update_queue", runtime, queue: items, removed: [] }) as unknown as WsProtocolMessage;
const subagents = (statuses: string[]) =>
  ({
    type: "update_subagent_state",
    runtime,
    subagents: statuses.map((status) => ({ status })),
  }) as unknown as WsProtocolMessage;

/** A hand-driven clock: `advance` fires due timers in order. */
function fakeClock() {
  let t = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => t,
    setTimeout: (fn, ms) => {
      id += 1;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
  };
  const advance = (ms: number) => {
    const until = t + ms;
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      timers.delete(next[0]);
      t = next[1].at;
      next[1].fn();
    }
    t = until;
  };
  return { clock, advance };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(watched = false, name: string | null = "resume-creator") {
  const notify = mock(async (_s: unknown, _p: unknown, _e: unknown, _l: unknown) => {});
  const { clock, advance } = fakeClock();
  const watcher = new TurnOutcomeWatcher(
    {} as ConstructorParameters<typeof TurnOutcomeWatcher>[0],
    () => {},
    { name: async () => name },
    notify,
    clock,
  );
  const see = (frame: WsProtocolMessage) => watcher.observe(frame, () => watched);
  const payload = (i = 0) =>
    notify.mock.calls[i]?.[1] as { title: string; body: string; url: string };
  return { notify, see, advance, payload };
}

describe("TurnOutcomeWatcher", () => {
  test("a finished turn is reported once the conversation stays quiet", async () => {
    const { notify, see, advance, payload } = setup();
    see(finished());
    advance(SETTLE_MS - 1);
    await flush();
    expect(notify).not.toHaveBeenCalled();
    advance(1);
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[2]).toBe("completed");
    expect(payload()).toMatchObject({
      title: "resume-creator",
      body: "Finished its turn.",
      url: "/?agent=agent-1&conversation=conv-1",
    });
  });

  test("a follow-up turn starting cancels the push; one push after the last turn", async () => {
    const { notify, see, advance } = setup();
    see(finished());
    advance(1000);
    see(processing(true)); // the queued task notification's turn begins
    advance(SETTLE_MS * 3);
    await flush();
    expect(notify).not.toHaveBeenCalled();
    see(finished());
    advance(SETTLE_MS);
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test("waits while messages are queued or subagents are running", async () => {
    const { notify, see, advance } = setup();
    see(subagents(["running"]));
    see(queue([{}]));
    see(finished());
    advance(SETTLE_MS * 10);
    await flush();
    expect(notify).not.toHaveBeenCalled();
    see(queue([]));
    see(subagents(["completed"]));
    advance(SETTLE_MS);
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test("a paused queue item does not hold the push", async () => {
    const { notify, see, advance } = setup();
    see(queue([{ paused: true }]));
    see(finished());
    advance(SETTLE_MS);
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test("reports the LAST turn's outcome: an error that was recovered from is not pushed", async () => {
    const { notify, see, advance } = setup();
    see(finished("boom"));
    see(processing(true));
    see(finished());
    advance(SETTLE_MS);
    await flush();
    expect(notify.mock.calls[0]?.[2]).toBe("completed");
  });

  test("a final failure names the agent and the error", async () => {
    const { notify, see, advance, payload } = setup();
    see(finished('Conversation is still busy\n{"body":"raw"}'));
    advance(SETTLE_MS);
    await flush();
    expect(notify.mock.calls[0]?.[2]).toBe("failed");
    expect(payload()).toMatchObject({
      title: "resume-creator",
      body: "Hit an error: Conversation is still busy",
    });
  });

  test("a subagent that never finishes cannot swallow the push", async () => {
    const { notify, see, advance } = setup();
    see(subagents(["running"]));
    see(finished());
    advance(MAX_HOLD_MS);
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test("watching is decided when the push is due", async () => {
    const { notify, see, advance } = setup(true);
    see(finished());
    advance(SETTLE_MS);
    await flush();
    expect(notify).not.toHaveBeenCalled();
  });

  test("no name available falls back to Letta", async () => {
    const { see, advance, payload } = setup(false, null);
    see(finished());
    advance(SETTLE_MS);
    await flush();
    expect(payload().title).toBe("Letta");
  });

  test("ignores frames without a scope", async () => {
    const { notify, see, advance } = setup();
    see({
      type: "turn_finished",
      turn_id: "t",
      stop_reason: "end_turn",
    } as unknown as WsProtocolMessage);
    advance(SETTLE_MS);
    await flush();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("failureBody", () => {
  test("clips a long error and falls back when empty", () => {
    const long = failureBody("x".repeat(500));
    expect(long.length).toBe("Hit an error: ".length + PUSH_ERROR_EXCERPT_CHARS);
    expect(long.endsWith("…")).toBe(true);
    expect(failureBody("  \n ")).toBe("Hit an error.");
  });
});
