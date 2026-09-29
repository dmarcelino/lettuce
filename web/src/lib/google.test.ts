import { expect, test } from "bun:test";
import { shortScope, wouldNarrow } from "./google.ts";

const base = { gmail: "send", calendar: "full", tasks: "manage", contacts: "full" };

test("wouldNarrow flags a lower level or a service turned off", () => {
  expect(wouldNarrow(base, { ...base, gmail: "readonly" })).toBe(true);
  expect(wouldNarrow(base, { ...base, calendar: null })).toBe(true);
  expect(wouldNarrow(base, { ...base, gmail: "full" })).toBe(false);
  expect(wouldNarrow(base, { ...base, contacts: "readonly" })).toBe(true);
  expect(wouldNarrow({ ...base, contacts: null }, { ...base })).toBe(false);
});

test("tasks manage and full share a scope, so neither direction narrows", () => {
  expect(wouldNarrow({ ...base, tasks: "full" }, base)).toBe(false);
  expect(wouldNarrow(base, { ...base, tasks: "full" })).toBe(false);
});

test("shortScope", () => {
  expect(shortScope("https://www.googleapis.com/auth/gmail.readonly")).toBe("gmail.readonly");
  expect(shortScope("openid")).toBe("openid");
});
