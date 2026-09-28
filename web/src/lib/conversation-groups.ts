/**
 * Date grouping and labels for the conversation switcher.
 *
 * Titles repeat ("Am I a good fit for https://www.linkedin.com/jobs/…" five
 * times over), so the date is what tells conversations apart — each card shows
 * one and the list is sectioned by when.
 */

export interface Dated {
  updatedAt?: string;
}

export interface DateGroup<T> {
  label: string;
  items: T[];
}

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function groupLabel(at: number, now: Date, locale?: string): string {
  const today = startOfDay(now);
  if (at >= today) return "Today";
  if (at >= today - DAY) return "Yesterday";
  if (at >= today - 7 * DAY) return "Previous 7 days";
  const date = new Date(at);
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(locale, {
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * Newest first, sectioned Today / Yesterday / Previous 7 days / by month.
 * An item without a parseable date keeps its place at the end, under "Older".
 */
export function groupByDate<T extends Dated>(
  items: readonly T[],
  now: Date = new Date(),
  locale?: string,
): DateGroup<T>[] {
  const dated = items.map((item) => ({
    item,
    at: item.updatedAt ? Date.parse(item.updatedAt) : Number.NaN,
  }));
  const known = dated.filter((d) => !Number.isNaN(d.at)).sort((a, b) => b.at - a.at);
  const unknown = dated.filter((d) => Number.isNaN(d.at));

  const groups: DateGroup<T>[] = [];
  for (const { item, at } of known) {
    const label = groupLabel(at, now, locale);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  if (unknown.length > 0) groups.push({ label: "Older", items: unknown.map((d) => d.item) });
  return groups;
}

/** A card's date: the time for today, "Sep 21" this year, "Sep 21, 2025" before. */
export function listDate(iso: string | undefined, now: Date = new Date(), locale?: string): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const date = new Date(at);
  if (at >= startOfDay(now)) {
    return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * `listDate` for any timestamp a list row carries (epoch ms or a date string),
 * so every list in the app — conversations, files, tasks, runs, memory history —
 * says "05:07 PM" / "Sep 21" the same way.
 */
export function shortDate(value: string | number, now: Date = new Date(), locale?: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : listDate(date.toISOString(), now, locale);
}

export interface Listable extends Dated {
  id: string;
  summary: string;
  archived?: boolean;
}

/**
 * The conversations a list shows: archived ones only on request — except one
 * that is responding, since hiding the one busy thing would defeat the
 * indicator — narrowed by a case-insensitive title search. Shared by the
 * switcher and the desktop sidebar, so the two lists never disagree.
 */
export function visibleConversations<T extends Listable>(
  conversations: readonly T[],
  options: { showArchived: boolean; query: string; responding: ReadonlySet<string> },
): T[] {
  const needle = options.query.trim().toLowerCase();
  return conversations.filter(
    (conversation) =>
      (options.showArchived || !conversation.archived || options.responding.has(conversation.id)) &&
      (!needle || conversation.summary.toLowerCase().includes(needle)),
  );
}
