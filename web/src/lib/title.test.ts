import { describe, expect, test } from "bun:test";
import { conversationTitle } from "./title.ts";

describe("conversationTitle", () => {
  test("a short message is used as-is", () => {
    expect(conversationTitle("tell me about your capabilities")).toBe(
      "tell me about your capabilities",
    );
  });

  test("a long message is cut on a word boundary", () => {
    const source = "help me rewrite the summary section of my CV for a backend role at a fintech";
    const title = conversationTitle(source);
    expect(title).toEndWith("…");
    expect(title!.length).toBeLessThanOrEqual(52);

    // The real property: what precedes the ellipsis is a whole-word prefix of
    // the original — the next character in the source is a space, not a letter.
    const head = title!.slice(0, -1);
    expect(source.startsWith(head)).toBe(true);
    expect(source.charAt(head.length)).toBe(" ");
  });

  test("an injected reminder does not become the title", () => {
    // Real shape: the reminder is prepended to what the user typed.
    const raw =
      "<system-reminder>\nThis is an automated message providing context.\n</system-reminder>tell me about your capabilities";
    expect(conversationTitle(raw)).toBe("tell me about your capabilities");
  });

  test("a reminder-only message yields no title", () => {
    expect(conversationTitle("<system-reminder>\nenvironment\n</system-reminder>")).toBeNull();
  });

  test("slash commands and blanks are not titles", () => {
    expect(conversationTitle("/compact")).toBeNull();
    expect(conversationTitle("   ")).toBeNull();
    expect(conversationTitle("")).toBeNull();
  });

  test("whitespace is collapsed and quotes stripped", () => {
    expect(conversationTitle('  "hello   there"  ')).toBe("hello there");
    expect(conversationTitle("line one\nline two")).toBe("line one line two");
  });

  test("never exceeds the upstream 100-char limit", () => {
    const title = conversationTitle("x".repeat(500));
    expect(title!.length).toBeLessThanOrEqual(100);
  });
});
