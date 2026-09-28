import { describe, expect, test } from "bun:test";
import { describeCron } from "./cron-describe.ts";

describe("describeCron", () => {
  test.each([
    ["0 9 * * *", "Every day at 09:00"],
    ["30 18 * * *", "Every day at 18:30"],
    ["0 9 * * 1-5", "Weekdays at 09:00"],
    ["0 10 * * 0,6", "Weekends at 10:00"],
    ["0 9 * * 1", "Mondays at 09:00"],
    ["15 8 * * 1,4", "Mondays and Thursdays at 08:15"],
    ["0 9 * * 7", "Sundays at 09:00"],
    ["0 9 * * 0-6", "Every day at 09:00"],
    ["0 9 1 * *", "Monthly on the 1st at 09:00"],
    ["0 9 22 * *", "Monthly on the 22nd at 09:00"],
    ["0 9 13 * *", "Monthly on the 13th at 09:00"],
    ["* * * * *", "Every minute"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["5 * * * *", "Every hour at :05"],
    ["0 */6 * * *", "Every 6 hours at :00"],
    ["  0   9 * * *  ", "Every day at 09:00"],
  ])("%s → %s", (expression, expected) => {
    expect(describeCron(expression)).toBe(expected);
  });

  test.each([
    "",
    "0 9 * *",
    "0 9 * * * *",
    "60 9 * * *",
    "0 24 * * *",
    "0 9 * 1 *",
    "0 9 1 * 1",
    "0 9 * * 8",
    "0 9 * * 5-1",
    "0 9-17 * * *",
    "0 9 32 * *",
  ])("%p is left undescribed", (expression) => {
    expect(describeCron(expression)).toBeNull();
  });
});
