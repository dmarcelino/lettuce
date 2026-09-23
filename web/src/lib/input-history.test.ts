import { describe, expect, test } from "bun:test";
import {
  AT_DRAFT,
  caretAllowsHistory,
  type HistoryCursor,
  historyDown,
  historyUp,
  userHistory,
} from "./input-history.ts";
import type { TranscriptEntry } from "./messages.ts";

function entry(kind: TranscriptEntry["kind"], text: string, extra: Partial<TranscriptEntry> = {}) {
  return { id: text, kind, date: "", seenAt: 0, text, ...extra } as TranscriptEntry;
}

describe("userHistory", () => {
  test("keeps only typed user messages, oldest first, collapsing repeats", () => {
    expect(
      userHistory([
        entry("user", "first"),
        entry("assistant", "reply"),
        entry("user", "  second  "),
        entry("user", "second"),
        entry("user", "from telegram", { channel: "telegram" }),
        entry("user", "subagent prompt", { subagentId: "s1" }),
        entry("user", "   "),
        entry("user", "third"),
      ]),
    ).toEqual(["first", "second", "third"]);
  });
});

describe("history navigation", () => {
  const history = ["one", "two", "three"];

  test("up walks back from the newest and stops at the oldest", () => {
    let cursor: HistoryCursor = AT_DRAFT;
    const seen: string[] = [];
    for (;;) {
      const step = historyUp(history, cursor, "my draft");
      if (!step) break;
      cursor = step.cursor;
      seen.push(step.value);
    }
    expect(seen).toEqual(["three", "two", "one"]);
    expect(cursor.index).toBe(0);
  });

  test("an unsent draft survives going up and back down", () => {
    const up1 = historyUp(history, AT_DRAFT, "half-typed")!;
    const up2 = historyUp(history, up1.cursor, up1.value)!;
    const down1 = historyDown(history, up2.cursor)!;
    expect(down1.value).toBe("three");
    const down2 = historyDown(history, down1.cursor)!;
    expect(down2.value).toBe("half-typed");
    expect(down2.cursor).toEqual(AT_DRAFT);
    expect(historyDown(history, down2.cursor)).toBeNull();
  });

  test("an empty history goes nowhere", () => {
    expect(historyUp([], AT_DRAFT, "x")).toBeNull();
  });
});

describe("caretAllowsHistory", () => {
  test("up only from the first line, down only from the last", () => {
    const text = "line one\nline two";
    expect(caretAllowsHistory("ArrowUp", text, 3, 3)).toBe(true);
    expect(caretAllowsHistory("ArrowUp", text, 12, 12)).toBe(false);
    expect(caretAllowsHistory("ArrowDown", text, 12, 12)).toBe(true);
    expect(caretAllowsHistory("ArrowDown", text, 3, 3)).toBe(false);
  });

  test("never with a selection", () => {
    expect(caretAllowsHistory("ArrowUp", "abc", 0, 2)).toBe(false);
  });
});
