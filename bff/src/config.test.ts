import { describe, expect, test } from "bun:test";
import { parseAllowedUsers } from "./config";

describe("parseAllowedUsers", () => {
  test("splits a comma-separated list", () => {
    expect(parseAllowedUsers("a@example.com,b@example.com", "src")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  test("accepts a single address", () => {
    expect(parseAllowedUsers("solo@example.com", "src")).toEqual(["solo@example.com"]);
  });

  test("normalizes case and surrounding space", () => {
    // isAllowedUser() compares against an already-lowercased address, so a
    // capitalized entry would never match without this.
    expect(parseAllowedUsers("  Mixed@Case.COM , B@Example.com ", "src")).toEqual([
      "mixed@case.com",
      "b@example.com",
    ]);
  });

  test("de-duplicates, including across case differences", () => {
    expect(parseAllowedUsers("a@example.com, A@Example.com", "src")).toEqual(["a@example.com"]);
  });

  test("ignores empty entries rather than yielding blanks", () => {
    expect(parseAllowedUsers("a@example.com,,", "src")).toEqual(["a@example.com"]);
  });

  test("rejects a value with no addresses at all", () => {
    expect(() => parseAllowedUsers(",,,", "ALLOWED_USERS")).toThrow(
      /ALLOWED_USERS lists no addresses/,
    );
  });

  test("rejects an empty string", () => {
    expect(() => parseAllowedUsers("   ", "ALLOWED_USERS")).toThrow(/no addresses/);
  });

  test("rejects an entry that is not an address, naming it", () => {
    // The point of this check is to fail at boot instead of as an unexplained
    // 403 at sign-in — an address matching nothing is otherwise silent.
    expect(() => parseAllowedUsers("a@example.com, oops", "ALLOWED_USERS")).toThrow(
      /not email addresses: oops/,
    );
  });

  test("does not reject unusual but valid addresses", () => {
    // Guards against someone 'improving' the @ check into an email regex.
    const exotic = "a+tag@sub.example.co.uk, first.last@example.museum";
    expect(parseAllowedUsers(exotic, "src")).toEqual([
      "a+tag@sub.example.co.uk",
      "first.last@example.museum",
    ]);
  });

  test("names the source in errors so the operator knows what to fix", () => {
    expect(() => parseAllowedUsers("", "SOME_SOURCE")).toThrow(/SOME_SOURCE/);
  });
});
