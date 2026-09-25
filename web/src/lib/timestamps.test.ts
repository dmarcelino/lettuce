import { describe, expect, test } from "bun:test";
import {
  formatEntryTime,
  formatEntryTimeFull,
  readShowTimestamps,
  writeShowTimestamps,
} from "./timestamps.ts";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

const opts = { now: new Date("2026-09-25T18:00:00Z"), locale: "en-GB", timeZone: "UTC" };

describe("timestamp preference", () => {
  test("on by default, and remembers off", () => {
    const storage = memoryStorage();
    expect(readShowTimestamps(storage)).toBe(true);
    writeShowTimestamps(false, storage);
    expect(readShowTimestamps(storage)).toBe(false);
    writeShowTimestamps(true, storage);
    expect(readShowTimestamps(storage)).toBe(true);
  });

  test("no storage, or storage that throws, means on", () => {
    expect(readShowTimestamps(null)).toBe(true);
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readShowTimestamps(throwing)).toBe(true);
    expect(() => writeShowTimestamps(false, throwing)).not.toThrow();
  });
});

describe("formatEntryTime", () => {
  test("today shows the time only", () => {
    expect(formatEntryTime("2026-09-25T14:31:18Z", opts)).toBe("14:31");
  });

  test("an earlier day this year adds the date", () => {
    expect(formatEntryTime("2026-09-24T09:05:00Z", opts)).toBe("24 Sept, 09:05");
  });

  test("another year adds the year", () => {
    expect(formatEntryTime("2025-12-31T23:59:00Z", opts)).toBe("31 Dec 2025, 23:59");
  });

  test("an unparseable date renders nothing", () => {
    expect(formatEntryTime("d", opts)).toBe("");
    expect(formatEntryTimeFull("", opts)).toBe("");
  });

  test("the full form carries seconds", () => {
    expect(formatEntryTimeFull("2026-09-25T14:31:18Z", opts)).toContain("14:31:18");
  });
});
