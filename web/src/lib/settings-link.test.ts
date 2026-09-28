import { describe, expect, test } from "bun:test";
import { readSettingsDeepLink } from "./settings-link.ts";

const isSection = (value: string): value is "google" | "mcp" =>
  value === "google" || value === "mcp";

function fakeHistory() {
  const urls: string[] = [];
  return {
    urls,
    replaceState: (_: unknown, __: string, url?: string | URL | null) =>
      void urls.push(String(url)),
  };
}

describe("readSettingsDeepLink", () => {
  test("opens the named section and strips the param", () => {
    const history = fakeHistory();
    const section = readSettingsDeepLink(
      isSection,
      { pathname: "/", search: "?settings=google" },
      history,
    );
    expect(section).toBe("google");
    expect(history.urls).toEqual(["/"]);
  });

  test("keeps other params", () => {
    const history = fakeHistory();
    readSettingsDeepLink(isSection, { pathname: "/", search: "?agent=a&settings=mcp" }, history);
    expect(history.urls).toEqual(["?agent=a"]);
  });

  test("an unknown section is stripped and ignored", () => {
    const history = fakeHistory();
    expect(
      readSettingsDeepLink(isSection, { pathname: "/", search: "?settings=nope" }, history),
    ).toBeNull();
    expect(history.urls).toEqual(["/"]);
  });

  test("no param touches nothing", () => {
    const history = fakeHistory();
    expect(readSettingsDeepLink(isSection, { pathname: "/", search: "" }, history)).toBeNull();
    expect(history.urls).toEqual([]);
  });
});
