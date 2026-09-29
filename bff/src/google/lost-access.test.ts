import { describe, expect, test } from "bun:test";
import {
  disabledApi,
  googleErrorAnswer,
  isGoogleAuthFailure,
  lostAccessMessage,
} from "./lost-access.ts";

// Verbatim from prod, 2026-09-28: what workspace-mcp returned for both tools.
const CALENDAR = `Error calling tool 'get_events': **Authentication Required: Token Expired/Revoked for Google Calendar**

Your Google authentication token for dmitriy.marchevsky.ai@gmail.com has expired or been revoked.
1. Run \`start_google_auth\` with your email (dmitriy.marchevsky.ai@gmail.com) and service_name='Google Calendar'`;
const TASKS =
  "Error calling tool 'list_tasks': An unexpected error occurred in list_tasks: Unexpected error: ('invalid_grant: Token has been expired or revoked.', {'error': 'invalid_grant'})";

// Verbatim from prod, 2026-09-28 18:45: the sign-in worked, the APIs were off in
// the Cloud project — and workspace-mcp still advised start_google_auth.
const CALENDAR_OFF =
  "Error calling tool 'get_events': API error in get_events: Google Calendar API is not enabled for your project (208111488297).";
const TASKS_OFF = `Error calling tool 'list_tasks': An unexpected error occurred in list_tasks: API error: <HttpError 403 when requesting https://tasks.googleapis.com/tasks/v1/lists/%40default/tasks?maxResults=20&alt=json returned "Google Tasks API has not been used in project 208111488297 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/tasks.googleapis.com/overview?project=208111488297 then retry.". Details: "[{'domain': 'usageLimits', 'reason': 'accessNotConfigured'}]">. You might need to re-authenticate. LLM: Try 'start_google_auth' with the user's email (dmitriy.marchevsky.ai@gmail.com) and service_name='Google Tasks'.`;

describe("isGoogleAuthFailure", () => {
  test("recognises workspace-mcp's auth failures", () => {
    expect(isGoogleAuthFailure(CALENDAR)).toBe(true);
    expect(isGoogleAuthFailure(TASKS)).toBe(true);
  });

  test("leaves ordinary errors alone", () => {
    expect(isGoogleAuthFailure("Event not found: abc")).toBe(false);
    expect(isGoogleAuthFailure("HttpError 403: insufficient permissions")).toBe(false);
  });

  test("a 403 carrying workspace-mcp's start_google_auth advice is not a lost sign-in", () => {
    expect(isGoogleAuthFailure(TASKS_OFF)).toBe(false);
    expect(isGoogleAuthFailure(CALENDAR_OFF)).toBe(false);
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
    const answer = await googleErrorAnswer(port, TASKS);
    expect(answer?.isError).toBe(true);
    expect(answer?.text).toContain("/api/google/reconnect");
    expect(lost).toHaveLength(1);
    expect(await googleErrorAnswer(port, "Event not found")).toBeNull();
    expect(lost).toHaveLength(1);
  });

  test("a failure to record still gives the agent the right answer", async () => {
    const answer = await googleErrorAnswer(
      { publicOrigin: "https://x", markLost: async () => Promise.reject(new Error("disk")) },
      CALENDAR,
    );
    expect(answer?.text).toContain("https://x/api/google/reconnect");
  });
});

describe("an API switched off in the Cloud project", () => {
  test("is recognised in both phrasings, with a link to its switch", () => {
    expect(disabledApi(CALENDAR_OFF)).toEqual({
      name: "Google Calendar API",
      project: "208111488297",
      enableUrl:
        "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=208111488297",
    });
    expect(disabledApi(TASKS_OFF)?.enableUrl).toBe(
      "https://console.cloud.google.com/apis/library/tasks.googleapis.com?project=208111488297",
    );
    const peopleOff =
      "Error calling tool 'list_contacts': API error: <HttpError 403 when requesting https://people.googleapis.com/v1/people/me/connections?alt=json returned \"Google People API has not been used in project 208111488297 before or it is disabled.\" Details: \"[{'domain': 'usageLimits', 'reason': 'accessNotConfigured'}]\">";
    expect(disabledApi(peopleOff)).toEqual({
      name: "Google People API",
      project: "208111488297",
      enableUrl:
        "https://console.cloud.google.com/apis/library/people.googleapis.com?project=208111488297",
    });
    expect(disabledApi("Event not found")).toBeNull();
  });

  test("tells the agent what to ask for, and records no loss", async () => {
    const lost: string[] = [];
    const port = {
      publicOrigin: "https://letta.example",
      markLost: async (why: string) => {
        lost.push(why);
        return { email: "me@example.com" };
      },
    };
    const answer = await googleErrorAnswer(port, TASKS_OFF);
    expect(answer?.text).toContain("Google Tasks API is switched off");
    expect(answer?.text).toContain("tasks.googleapis.com?project=208111488297");
    expect(answer?.text).not.toContain("/api/google/reconnect");
    expect(lost).toEqual([]);
  });

  test("any other error loses only the start_google_auth advice", async () => {
    const port = { publicOrigin: "https://x", markLost: async () => null };
    const text =
      "Error calling tool 'x': HttpError 403 insufficientPermissions. You might need to re-authenticate. LLM: Try 'start_google_auth' with the user's email (a@b.c) and service_name='Gmail'.";
    expect((await googleErrorAnswer(port, text))?.text).toBe(
      "Error calling tool 'x': HttpError 403 insufficientPermissions.",
    );
    expect(await googleErrorAnswer(port, "Event not found")).toBeNull();
  });
});
