import { describe, expect, test } from "bun:test";
import { findMonitorBackupWake, monitorBackupWakeName } from "./monitor-backup.ts";

interface Task {
  name: string;
  recurring: boolean;
  status: string;
  scheduled_for: string | null;
}

const wake = (over: Partial<Task> = {}): Task => ({
  name: monitorBackupWakeName("Gmail inbox"),
  recurring: false,
  status: "active",
  scheduled_for: "2026-10-19T16:32:00Z",
  ...over,
});

describe("monitorBackupWakeName", () => {
  test("mirrors upstream wakeName", () => {
    expect(monitorBackupWakeName("Gmail inbox")).toBe("Monitor backup: Gmail inbox");
    const long = "x".repeat(100);
    const name = monitorBackupWakeName(long);
    expect(name.length).toBe(80);
    expect(name.endsWith("…")).toBe(true);
  });
});

describe("findMonitorBackupWake", () => {
  test("matches the armed one-shot wake", () => {
    const armed = wake();
    const tasks = [wake({ name: "Morning brief", recurring: true }), armed];
    expect(findMonitorBackupWake("Gmail inbox", tasks)).toBe(armed);
  });

  test("matches the truncated name for a long description", () => {
    const long = "x".repeat(100);
    const armed = wake({ name: monitorBackupWakeName(long) });
    expect(findMonitorBackupWake(long, [armed])).toBe(armed);
  });

  test("ignores recurring, non-active and unscheduled tasks", () => {
    expect(findMonitorBackupWake("Gmail inbox", [wake({ recurring: true })])).toBeNull();
    expect(findMonitorBackupWake("Gmail inbox", [wake({ status: "paused" })])).toBeNull();
    expect(findMonitorBackupWake("Gmail inbox", [wake({ status: "completed" })])).toBeNull();
    expect(findMonitorBackupWake("Gmail inbox", [wake({ scheduled_for: null })])).toBeNull();
  });

  test("ignores a different monitor's wake", () => {
    expect(findMonitorBackupWake("Other watch", [wake()])).toBeNull();
  });
});
