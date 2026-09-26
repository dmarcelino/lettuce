import { describe, expect, test } from "bun:test";
import { fetchAgentStats, statsOf } from "./use-agent-stats.ts";

const conversation = (id: string, updated_at: string, archived = false) => ({
  id,
  summary: id,
  updated_at,
  archived,
});

describe("fetchAgentStats", () => {
  test("asks for every agent at once rather than one after another", async () => {
    let inFlight = 0;
    let peak = 0;
    const request = (async (_type: string, body: { query: { agent_id: string } }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { conversations: [conversation(`${body.query.agent_id}-c`, "2026-09-20T10:00:00Z")] };
    }) as never;
    const stats = await fetchAgentStats(request, ["a", "b", "c"]);
    expect(peak).toBe(3);
    expect([...stats.keys()]).toEqual(["a", "b", "c"]);
  });

  test("an agent whose lookup fails is left out, the rest still count", async () => {
    const request = (async (_type: string, body: { query: { agent_id: string } }) => {
      if (body.query.agent_id === "bad") throw new Error("boom");
      return { conversations: [conversation("x", "2026-09-20T10:00:00Z")] };
    }) as never;
    const stats = await fetchAgentStats(request, ["good", "bad"]);
    expect([...stats.keys()]).toEqual(["good"]);
  });
});

describe("statsOf", () => {
  test("counts live conversations and takes the latest update", () => {
    expect(
      statsOf([
        { id: "1", summary: "", titled: false, archived: false, updatedAt: "2026-09-01T00:00:00Z" },
        { id: "2", summary: "", titled: false, archived: false, updatedAt: "2026-09-20T00:00:00Z" },
        { id: "3", summary: "", titled: false, archived: true, updatedAt: "2026-09-25T00:00:00Z" },
      ]),
    ).toEqual({ count: 2, lastActive: "2026-09-20T00:00:00Z" });
  });
});
