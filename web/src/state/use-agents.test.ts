import { describe, expect, test } from "bun:test";
import { readConversations } from "./use-agents.ts";

/**
 * `titled` is the rule that protects a manual rename from being overwritten by
 * auto-titling, so it is worth asserting directly rather than through the hook.
 */
describe("conversation titled flag", () => {
  const parse = (summary: unknown) =>
    readConversations({ conversations: [{ id: "c1", summary }] })[0]!;

  test("a null summary is untitled and shows the placeholder", () => {
    const c = parse(null);
    expect(c.titled).toBe(false);
    expect(c.summary).toBe("Untitled");
  });

  test("a missing summary is untitled", () => {
    expect(readConversations({ conversations: [{ id: "c1" }] })[0]!.titled).toBe(false);
  });

  test("a whitespace-only summary is untitled", () => {
    expect(parse("   ").titled).toBe(false);
  });

  test("a real summary is titled and kept verbatim", () => {
    const c = parse("CV summary rewrite");
    expect(c.titled).toBe(true);
    expect(c.summary).toBe("CV summary rewrite");
  });

  test('a conversation the user actually named "Untitled" is still titled', () => {
    // The case the flag exists for: without it, this would be re-titled.
    const c = parse("Untitled");
    expect(c.titled).toBe(true);
    expect(c.summary).toBe("Untitled");
  });
});
