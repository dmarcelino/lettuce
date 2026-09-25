import { describe, expect, test } from "bun:test";
import type { ActiveScope } from "./session/activity.ts";
import { drainActiveTurns } from "./shutdown.ts";

const scope: ActiveScope = { agent_id: "agent-1", conversation_id: "conv-1" };

/** A fake clock the fake sleep advances, so the drain runs instantly. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const never = new Promise<void>(() => {});

describe("drainActiveTurns", () => {
  test("returns idle at once when nothing is running", async () => {
    const logs: string[] = [];
    const result = await drainActiveTurns({
      activeScopes: () => [],
      timeoutMs: 60_000,
      log: (m) => logs.push(m),
      interrupted: never,
      ...clock(),
    });
    expect(result).toBe("idle");
    expect(logs).toEqual([]);
  });

  test("waits while a turn runs and returns drained when it ends", async () => {
    const c = clock();
    let polls = 0;
    const result = await drainActiveTurns({
      activeScopes: () => (++polls <= 5 ? [scope] : []),
      timeoutMs: 60_000,
      log: () => {},
      interrupted: never,
      pollMs: 1000,
      ...c,
    });
    expect(result).toBe("drained");
    expect(c.now()).toBe(5000);
  });

  test("gives up at the timeout and names what it abandons", async () => {
    const logs: string[] = [];
    const result = await drainActiveTurns({
      activeScopes: () => [scope],
      timeoutMs: 10_000,
      log: (m) => logs.push(m),
      interrupted: never,
      pollMs: 1000,
      ...clock(),
    });
    expect(result).toBe("timed_out");
    expect(logs.at(-1)).toContain("abandoning 1 active turn(s): agent-1/conv-1");
  });

  test("a second signal stops the drain immediately", async () => {
    let fire: () => void = () => {};
    const interrupted = new Promise<void>((resolve) => {
      fire = resolve;
    });
    const pending = drainActiveTurns({
      activeScopes: () => [scope],
      timeoutMs: 60_000,
      log: () => {},
      interrupted,
      // Real sleep that never resolves: only the interrupt can end the wait.
      sleep: () => never,
    });
    fire();
    expect(await pending).toBe("interrupted");
  });
});
