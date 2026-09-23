import { describe, expect, test } from "bun:test";
import { agentActivity } from "./activity.ts";

const active = new Set(["a1::c1", "a1::default", "a1::c-new", "a2::c9"]);

describe("agentActivity", () => {
  test("collects only the selected agent's conversations", () => {
    expect([...agentActivity(active, "a1", ["c1"]).responding].sort()).toEqual([
      "c-new",
      "c1",
      "default",
    ]);
    expect([...agentActivity(active, "a2", []).responding]).toEqual(["c9"]);
  });

  test("the default conversation is flagged, never counted as unlisted", () => {
    const activity = agentActivity(active, "a1", ["c1"]);
    expect(activity.inDefault).toBe(true);
    expect(activity.unlisted).toEqual(["c-new"]);
  });

  test("nothing selected, nothing responding", () => {
    const activity = agentActivity(active, null, []);
    expect(activity.responding.size).toBe(0);
    expect(activity.inDefault).toBe(false);
    expect(activity.unlisted).toEqual([]);
  });
});
