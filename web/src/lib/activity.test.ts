import { describe, expect, test } from "bun:test";
import { activityRows, agentActivity } from "./activity.ts";

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

const roster = [
  { id: "a1", name: "Alpha" },
  { id: "a2", name: "Beta" },
];
const titles = new Map([
  [
    "a1",
    [
      { id: "c1", summary: "First" },
      { id: "c2", summary: "Second" },
    ],
  ],
  [
    "a2",
    [
      { id: "c9", summary: "Nine" },
      { id: "c8", summary: "Eight" },
    ],
  ],
]);

describe("activityRows", () => {
  test("current agent first, then agent list order", () => {
    const rows = activityRows(new Set(["a2::c9", "a1::c1"]), roster, "a1", "c1", titles);
    expect(rows.map((r) => `${r.agentId}/${r.conversationId}`)).toEqual(["a1/c1", "a2/c9"]);
    expect(rows[0]!.isCurrent).toBe(true);
    expect(rows[1]!.isCurrent).toBe(false);
  });

  test("current conversation first within its agent", () => {
    const rows = activityRows(new Set(["a1::c2", "a1::c1"]), roster, "a1", "c1", titles);
    expect(rows.map((r) => r.conversationId)).toEqual(["c1", "c2"]);
  });

  test("the default conversation is a note row, never current", () => {
    const rows = activityRows(new Set(["a1::default"]), roster, "a1", "default", titles);
    expect(rows[0]!.kind).toBe("default");
    expect(rows[0]!.isCurrent).toBe(false);
    expect(rows[0]!.title).toContain("Default conversation");
  });

  test("a conversation missing from the list falls back to unlisted", () => {
    const rows = activityRows(new Set(["a1::c-new"]), roster, "a1", null, titles);
    expect(rows[0]!.kind).toBe("unlisted");
    expect(rows[0]!.title).toBe("Conversation (not in list yet)");
  });

  test("an unknown agent falls back to its raw id", () => {
    const rows = activityRows(new Set(["zz::c1"]), roster, null, null, new Map());
    expect(rows[0]!.agentName).toBe("zz");
    expect(rows[0]!.kind).toBe("unlisted");
  });

  test("titles resolve from the fetched lists", () => {
    const rows = activityRows(new Set(["a2::c8", "a1::c2"]), roster, null, null, titles);
    expect(rows.map((r) => r.title)).toEqual(["Second", "Eight"]);
    expect(rows.map((r) => r.kind)).toEqual(["conversation", "conversation"]);
  });
});
