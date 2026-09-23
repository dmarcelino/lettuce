import type { TranscriptEntry } from "./messages.ts";

/**
 * Shell-style recall of past messages in the composer.
 *
 * The history is this conversation's own user messages, read from the
 * transcript, so it survives reloads and includes what was sent from another
 * device. Excluded: channel messages (someone else, over Telegram), subagent
 * turns, and the machine-injected blocks `sortedEntries` has already lifted out
 * of user messages into entries of their own.
 */
export function userHistory(entries: readonly TranscriptEntry[]): string[] {
  const history: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "user" || entry.channel || entry.subagentId) continue;
    const text = entry.text.trim();
    // Consecutive repeats collapse, like a shell's ignoredups.
    if (text && history[history.length - 1] !== text) history.push(text);
  }
  return history;
}

/**
 * Where the composer is in the history.
 *
 * `index` is null while editing the draft, otherwise a position in the history
 * (0 = oldest). `draft` is what was in the box before the first step up, and it
 * is what stepping back down past the newest entry restores.
 */
export interface HistoryCursor {
  index: number | null;
  draft: string;
}

export const AT_DRAFT: HistoryCursor = { index: null, draft: "" };

/** One step older. Null when there is nowhere to go. */
export function historyUp(
  history: readonly string[],
  cursor: HistoryCursor,
  current: string,
): { cursor: HistoryCursor; value: string } | null {
  if (history.length === 0) return null;
  if (cursor.index === null) {
    const index = history.length - 1;
    return { cursor: { index, draft: current }, value: history[index]! };
  }
  if (cursor.index === 0) return null;
  const index = cursor.index - 1;
  return { cursor: { ...cursor, index }, value: history[index]! };
}

/** One step newer; past the newest entry, back to the draft. Null when already there. */
export function historyDown(
  history: readonly string[],
  cursor: HistoryCursor,
): { cursor: HistoryCursor; value: string } | null {
  if (cursor.index === null) return null;
  if (cursor.index >= history.length - 1) {
    return { cursor: AT_DRAFT, value: cursor.draft };
  }
  const index = cursor.index + 1;
  return { cursor: { ...cursor, index }, value: history[index]! };
}

/**
 * Whether an arrow key should move through history rather than the text: only
 * with a collapsed caret on the first line (up) or the last line (down), so a
 * multi-line message can still be navigated line by line.
 */
export function caretAllowsHistory(
  key: "ArrowUp" | "ArrowDown",
  value: string,
  selectionStart: number,
  selectionEnd: number,
): boolean {
  if (selectionStart !== selectionEnd) return false;
  return key === "ArrowUp"
    ? !value.slice(0, selectionStart).includes("\n")
    : !value.slice(selectionEnd).includes("\n");
}
