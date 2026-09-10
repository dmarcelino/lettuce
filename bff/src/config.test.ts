import { describe, expect, test } from "bun:test";
import { parseAllowedUsers } from "./config";

describe("parseAllowedUsers — JSON", () => {
  test("reads the users.json shape and keeps names", () => {
    expect(parseAllowedUsers('[{"email":"A@Example.com","name":"Dima"}]', "src")).toEqual([
      { email: "a@example.com", name: "Dima" },
    ]);
  });

  test("normalizes email case and surrounding space", () => {
    // isAllowedUser() compares against an already-lowercased address, so the
    // normalization has to happen here or a capitalized allowlist never matches.
    expect(parseAllowedUsers('[{"email":"  Mixed@Case.COM  "}]', "src")).toEqual([
      { email: "mixed@case.com" },
    ]);
  });

  test("omits name when absent rather than inventing one", () => {
    expect(parseAllowedUsers('[{"email":"a@example.com"}]', "src")[0]).not.toHaveProperty("name");
  });

  test("rejects an empty array", () => {
    expect(() => parseAllowedUsers("[]", "src")).toThrow(/non-empty array/);
  });

  test("rejects an entry with no email, naming the index", () => {
    expect(() => parseAllowedUsers('[{"email":"a@example.com"},{"name":"B"}]', "src")).toThrow(
      /src\[1\]/,
    );
  });

  test("reports invalid JSON against the source name", () => {
    expect(() => parseAllowedUsers("[{oops}]", "USERS_FILE")).toThrow(/USERS_FILE is not valid/);
  });

  test("rejects an empty string", () => {
    expect(() => parseAllowedUsers("   ", "src")).toThrow(/empty/);
  });
});

describe("parseAllowedUsers — bare emails", () => {
  test("splits a comma-separated list when opted in", () => {
    expect(parseAllowedUsers("a@example.com, B@Example.com", "ALLOWED_USERS", true)).toEqual([
      { email: "a@example.com" },
      { email: "b@example.com" },
    ]);
  });

  test("accepts a single address", () => {
    expect(parseAllowedUsers("solo@example.com", "ALLOWED_USERS", true)).toEqual([
      { email: "solo@example.com" },
    ]);
  });

  test("ignores trailing separators rather than yielding a blank entry", () => {
    expect(parseAllowedUsers("a@example.com,,", "ALLOWED_USERS", true)).toEqual([
      { email: "a@example.com" },
    ]);
  });

  test("still parses JSON when opted in, so both env shapes work", () => {
    expect(parseAllowedUsers('[{"email":"a@example.com"}]', "ALLOWED_USERS", true)).toEqual([
      { email: "a@example.com" },
    ]);
  });

  test("a comma-only value is rejected, not silently empty", () => {
    expect(() => parseAllowedUsers(",,,", "ALLOWED_USERS", true)).toThrow(/no addresses/);
  });

  test("the shorthand is env-only: a malformed file is an error, not one address", () => {
    // The regression this guards: without the opt-in, `{}` in users.json would
    // parse as a single allowlisted address named "{}".
    expect(() => parseAllowedUsers("{}", "users.json")).toThrow(/not valid JSON|non-empty array/);
  });
});
