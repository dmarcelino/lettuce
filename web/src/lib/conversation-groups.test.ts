import { describe, expect, test } from "bun:test";
import { groupByDate, listDate, shortDate, visibleConversations } from "./conversation-groups.ts";

// Local-time construction, so the day boundaries are the test machine's own.
const now = new Date(2026, 8, 26, 15, 0); // Sat Sep 26 2026, 15:00
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString();

describe("groupByDate", () => {
  test("sections newest first: today, yesterday, previous 7 days, then months", () => {
    const groups = groupByDate(
      [
        { id: "aug", updatedAt: at(2026, 7, 29) },
        { id: "today", updatedAt: at(2026, 8, 26, 9) },
        { id: "sep11", updatedAt: at(2026, 8, 11) },
        { id: "yesterday", updatedAt: at(2026, 8, 25) },
        { id: "week", updatedAt: at(2026, 8, 21) },
        { id: "lastyear", updatedAt: at(2025, 11, 31) },
      ],
      now,
      "en-US",
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Today", ["today"]],
      ["Yesterday", ["yesterday"]],
      ["Previous 7 days", ["week"]],
      ["September", ["sep11"]],
      ["August", ["aug"]],
      ["December 2025", ["lastyear"]],
    ]);
  });

  test("undated items go last, under Older, in their original order", () => {
    const groups = groupByDate(
      [{ id: "a" }, { id: "b", updatedAt: at(2026, 8, 26) }, { id: "c" }],
      now,
    );
    expect(groups.at(-1)).toEqual({ label: "Older", items: [{ id: "a" }, { id: "c" }] });
  });
});

describe("listDate", () => {
  test("time today, short date this year, with year before", () => {
    expect(listDate(at(2026, 8, 26, 9), now, "en-GB")).toBe("09:00");
    expect(listDate(at(2026, 8, 21), now, "en-US")).toBe("Sep 21");
    expect(listDate(at(2025, 11, 31), now, "en-US")).toBe("Dec 31, 2025");
    expect(listDate(undefined, now)).toBe("");
    expect(listDate("nope", now)).toBe("");
  });
});

describe("shortDate", () => {
  test("takes epoch milliseconds like listDate takes an ISO string", () => {
    const at = new Date(2026, 7, 21, 22, 30);
    expect(shortDate(at.getTime(), now, "en-US")).toBe(listDate(at.toISOString(), now, "en-US"));
    expect(shortDate(at.getTime(), now, "en-US")).toBe("Aug 21");
  });
  test("is empty for an unparseable value", () => {
    expect(shortDate("not a date", now)).toBe("");
  });
});

describe("visibleConversations", () => {
  const list = [
    { id: "a", summary: "Smoke test" },
    { id: "b", summary: "Codex e2e", archived: true },
    { id: "c", summary: "Weather in Redmond", archived: true },
  ];
  const none = new Set<string>();
  test("hides archived unless asked", () => {
    const shown = visibleConversations(list, { showArchived: false, query: "", responding: none });
    expect(shown.map((c) => c.id)).toEqual(["a"]);
    const all = visibleConversations(list, { showArchived: true, query: "", responding: none });
    expect(all).toHaveLength(3);
  });
  test("keeps an archived conversation that is responding", () => {
    const shown = visibleConversations(list, {
      showArchived: false,
      query: "",
      responding: new Set(["c"]),
    });
    expect(shown.map((c) => c.id)).toEqual(["a", "c"]);
  });
  test("searches titles case-insensitively", () => {
    const shown = visibleConversations(list, {
      showArchived: true,
      query: " CODEX ",
      responding: none,
    });
    expect(shown.map((c) => c.id)).toEqual(["b"]);
  });
});
