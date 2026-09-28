import { describe, expect, test } from "bun:test";
import { describeWebToolsStatus } from "./web-tools.ts";

describe("describeWebToolsStatus", () => {
  test("names each backend's state in plain words", () => {
    expect(
      describeWebToolsStatus({ searxng: "up", ddg: "down", modErrors: [], modInstalled: true }),
    ).toBe("Search (SearXNG): answering · Pages and search fallback (DuckDuckGo): not answering");
    expect(
      describeWebToolsStatus({ searxng: "off", ddg: "up", modErrors: [], modInstalled: true }),
    ).toContain("Search (SearXNG): switched off");
  });
});
