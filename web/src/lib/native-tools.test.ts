import { describe, expect, test } from "bun:test";
import { describeGoogleTools } from "./native-tools.ts";

describe("describeGoogleTools", () => {
  test("lists the tools, or says there are none", () => {
    expect(describeGoogleTools(["gmail_search", "gmail_read"])).toStartWith(
      "Agents' Google tools: gmail_search, gmail_read.",
    );
    expect(describeGoogleTools([])).toBe("Agents have no Google tools right now.");
  });
});
