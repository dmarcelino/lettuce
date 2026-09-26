import { describe, expect, mock, test } from "bun:test";
import { AGENT_NAME_TTL_MS, AgentNames } from "./agent-names.ts";

describe("AgentNames", () => {
  test("looks a name up once and caches it", async () => {
    const lookup = mock(async () => "resume-creator");
    const names = new AgentNames(lookup);
    expect(await names.name("a1")).toBe("resume-creator");
    expect(await names.name("a1")).toBe("resume-creator");
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test("refreshes after the TTL, so a rename shows up", async () => {
    let t = 0;
    let current = "old";
    const names = new AgentNames(
      async () => current,
      () => t,
    );
    expect(await names.name("a1")).toBe("old");
    current = "new";
    t = AGENT_NAME_TTL_MS;
    expect(await names.name("a1")).toBe("new");
  });

  test("a failed lookup answers null, or the stale name when there is one", async () => {
    let t = 0;
    let fail = false;
    const names = new AgentNames(
      async () => {
        if (fail) throw new Error("down");
        return "kept";
      },
      () => t,
    );
    expect(
      await new AgentNames(async () => {
        throw new Error("down");
      }).name("x"),
    ).toBeNull();
    expect(await names.name("a1")).toBe("kept");
    fail = true;
    t = AGENT_NAME_TTL_MS + 1;
    expect(await names.name("a1")).toBe("kept");
  });
});
