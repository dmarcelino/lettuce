import { describe, expect, test } from "bun:test";
import { conversationTargetLabel, type NamedConversation, NEW_CONVERSATION } from "./tasks.ts";

const conversations: NamedConversation[] = [
  { id: "conv-aaaa-1111", summary: "Trip planning" },
  { id: "conv-bbbb-2222", summary: "Untitled" },
];

describe("conversationTargetLabel", () => {
  test("the sentinel means a fresh conversation per run", () => {
    expect(conversationTargetLabel(NEW_CONVERSATION, conversations)).toBe(
      "New conversation each run",
    );
  });

  test("an absent target also reads as fresh-per-run", () => {
    expect(conversationTargetLabel(null, conversations)).toBe("New conversation each run");
    expect(conversationTargetLabel("", conversations)).toBe("New conversation each run");
    expect(conversationTargetLabel(undefined, conversations)).toBe("New conversation each run");
  });

  test("the agent-default sentinel is named", () => {
    expect(conversationTargetLabel("default", conversations)).toBe("Default conversation");
  });

  test("a known conversation resolves to its title", () => {
    expect(conversationTargetLabel("conv-aaaa-1111", conversations)).toBe("Trip planning");
    expect(conversationTargetLabel("conv-bbbb-2222", conversations)).toBe("Untitled");
  });

  test("an unknown id is shown truncated rather than hidden", () => {
    const label = conversationTargetLabel("conv-zzzz-9999-some-long-id", conversations);
    expect(label).toBe("Conversation conv-zzzz-99…");
    expect(label).not.toContain("some-long-id");
  });
});

describe("NEW_CONVERSATION", () => {
  test("matches upstream's sentinel string", () => {
    // cron-file.ts: `const conversationId = input.conversation_id ?? "new";`
    expect(NEW_CONVERSATION).toBe("new");
  });
});
