/**
 * Transcript timestamps: the on/off preference and the label format.
 *
 * On by default. Remembered per browser like the draft and the selection — it
 * is a reading preference, not conversation state, so nothing server-side
 * needs to know.
 */
import { defaultStorage, type MaybeStorage, readStored } from "./storage.ts";

const KEY = "lettuce:timestamps";

export function readShowTimestamps(storage: MaybeStorage = defaultStorage()): boolean {
  try {
    return readStored(storage, KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeShowTimestamps(show: boolean, storage: MaybeStorage = defaultStorage()): void {
  try {
    storage?.setItem(KEY, show ? "on" : "off");
  } catch {
    // No memory is fine — the toggle still works for this page.
  }
}

export interface TimeFormatOptions {
  now?: Date;
  /** Injectable for tests; defaults to the browser's own. */
  locale?: string;
  timeZone?: string;
}

/**
 * The short label shown beside an entry: the time alone for today, the date
 * and time for anything older, and the year only when it is not this one.
 * Empty for a date that does not parse, so a malformed frame shows nothing
 * rather than "Invalid Date".
 */
export function formatEntryTime(iso: string, options: TimeFormatOptions = {}): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = options.now ?? new Date();
  const zone = options.timeZone ? { timeZone: options.timeZone } : {};

  const time = date.toLocaleTimeString(options.locale, {
    hour: "2-digit",
    minute: "2-digit",
    ...zone,
  });
  const day = (d: Date) =>
    d.toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...zone });
  if (day(date) === day(now)) return time;

  const year = (d: Date) => d.toLocaleDateString("en-CA", { year: "numeric", ...zone });
  const calendar = date.toLocaleDateString(options.locale, {
    month: "short",
    day: "numeric",
    ...(year(date) === year(now) ? {} : { year: "numeric" }),
    ...zone,
  });
  return `${calendar}, ${time}`;
}

/** The full date and time, for the hover title. */
export function formatEntryTimeFull(iso: string, options: TimeFormatOptions = {}): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(options.locale, {
    dateStyle: "medium",
    timeStyle: "medium",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });
}
