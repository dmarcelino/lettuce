/**
 * A cron expression in plain English, for the New task form: "0 9 * * *" is
 * opaque to most people and easy to get subtly wrong, and the form used to give
 * no feedback at all. Covers the shapes people actually write — daily, weekdays,
 * given days of the week, a day of the month, hourly, every N minutes or hours.
 * Anything else returns null and the form keeps its generic field hint, rather
 * than guessing at a description that might be wrong.
 */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function int(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

/** `*\/N` → N, within bounds. */
function step(field: string, max: number): number | null {
  const match = /^\*\/(\d+)$/.exec(field);
  if (!match) return null;
  const value = Number(match[1]);
  return value >= 1 && value <= max ? value : null;
}

function time(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** "1,4" → [1, 4]; "1-5" → [1..5]; 7 is Sunday too. Null if anything is off. */
function weekdays(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to || to > 7) return null;
      for (let d = from; d <= to; d++) days.add(d % 7);
      continue;
    }
    const single = int(part, 0, 7);
    if (single === null) return null;
    days.add(single % 7);
  }
  return [...days].sort((a, b) => a - b);
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function describeCron(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteF, hourF, domF, monthF, dowF] = fields as [string, string, string, string, string];
  if (monthF !== "*") return null;

  const everyDay = domF === "*" && dowF === "*";

  if (everyDay && hourF === "*") {
    if (minuteF === "*") return "Every minute";
    const every = step(minuteF, 59);
    if (every !== null) return every === 1 ? "Every minute" : `Every ${every} minutes`;
    const minute = int(minuteF, 0, 59);
    if (minute !== null) return `Every hour at :${String(minute).padStart(2, "0")}`;
    return null;
  }

  const minute = int(minuteF, 0, 59);
  if (minute === null) return null;

  const everyHours = step(hourF, 23);
  if (everyHours !== null && everyDay) {
    const at = `:${String(minute).padStart(2, "0")}`;
    return everyHours === 1 ? `Every hour at ${at}` : `Every ${everyHours} hours at ${at}`;
  }

  const hour = int(hourF, 0, 23);
  if (hour === null) return null;
  const at = time(hour, minute);

  if (everyDay) return `Every day at ${at}`;

  if (domF === "*") {
    const days = weekdays(dowF);
    if (!days || days.length === 0) return null;
    if (days.length === 7) return `Every day at ${at}`;
    if (days.join() === "1,2,3,4,5") return `Weekdays at ${at}`;
    if (days.join() === "0,6") return `Weekends at ${at}`;
    return `${list(days.map((d) => `${DAY_NAMES[d]}s`))} at ${at}`;
  }

  if (dowF === "*") {
    const day = int(domF, 1, 31);
    if (day === null) return null;
    return `Monthly on the ${ordinal(day)} at ${at}`;
  }

  return null;
}
