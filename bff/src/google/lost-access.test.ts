import { describe, expect, test } from "bun:test";
import { isGoogleAuthFailure, lostAccessAnswer, lostAccessMessage } from "./lost-access.ts";

// Verbatim from prod, 2026-09-28: what workspace-mcp returned for both tools.
const CALENDAR = `Error calling tool 'get_events': **Authentication Required: Token Expired/Revoked for Google Calendar**

Your Google authentication token for dmitriy.marchevsky.ai@gmail.com has expired or been revoked.
1. Run \`start_google_auth\` with your email (dmitriy.marchevsky.ai@gmail.com) and service_name='Google Calendar'`;
const TASKS =
  "Error calling tool 'list_tasks': An unexpected error occurred in list_tasks: Unexpected error: ('invalid_grant: Token has been expired or revoked.', {'error': 'invalid_grant'})";

describe("isGoogleAuthFailure", () => {
  test("recognises workspace-mcp's auth failures", () => {
    expect(isGoogleAuthFailure(CALENDAR)).toBe(true);
    expect(isGoogleAuthFailure(TASKS)).toBe(true);
  });

  test("leaves ordinary errors alone", () => {
    expect(isGoogleAuthFailure("Event not found: abc")).toBe(false);
    expect(isGoogleAuthFailure("HttpError 403: insufficient permissions")).toBe(false);
  });
});

describe("the answer an agent gets", () => {
  test("says what to tell the user, with a one-click link, and never start_google_auth as a thing to run", () => {
    const text = lostAccessMessage("me@example.com", "https://letta.example");
    expect(text).toContain("me@example.com");
    expect(text).toContain("https://letta.example/api/google/reconnect");
    expect(text).toContain("https://letta.example/?settings=google");
    expect(text).toMatch(/Do not look for start_google_auth/);
  });

  test("records the loss and replaces the tool's text", async () => {
    const lost: string[] = [];
    const port = {
      publicOrigin: "https://letta.example",
      markLost: async (why: string) => {
        lost.push(why);
        return { email: "me@example.com" };
      },
    };
    const answer = await lostAccessAnswer(port, TASKS);
    expect(answer?.isError).toBe(true);
    expect(answer?.text).toContain("/api/google/reconnect");
    expect(lost).toHaveLength(1);
    expect(await lostAccessAnswer(port, "Event not found")).toBeNull();
    expect(lost).toHaveLength(1);
  });

  test("a failure to record still gives the agent the right answer", async () => {
    const answer = await lostAccessAnswer(
      { publicOrigin: "https://x", markLost: async () => Promise.reject(new Error("disk")) },
      CALENDAR,
    );
    expect(answer?.text).toContain("https://x/api/google/reconnect");
  });
});
