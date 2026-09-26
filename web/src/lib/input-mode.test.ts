import { describe, expect, test } from "bun:test";
import { enterSends } from "./input-mode.ts";

const media = (touch: boolean) => (query: string) => ({
  matches: touch && query === "(hover: none) and (pointer: coarse)",
});

describe("enterSends", () => {
  test("a phone: Enter is a newline", () => {
    expect(enterSends(media(true))).toBe(false);
  });
  test("a desktop: Enter sends", () => {
    expect(enterSends(media(false))).toBe(true);
  });
  test("no matchMedia at all: Enter sends", () => {
    expect(enterSends(undefined)).toBe(true);
  });
});
