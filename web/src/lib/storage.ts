/**
 * A `Storage` the caller is allowed to fail on.
 *
 * `localStorage` is not always there to be had: Safari's private mode has
 * historically thrown on write, an embedded webview can disable it outright,
 * and reading it from a sandboxed frame throws on *access*, before any method
 * is called. Everything built on this is a convenience — a remembered
 * selection, an unsent draft — so every path degrades to "no memory" rather
 * than taking the app down with it.
 */
export type MaybeStorage = Pick<Storage, "getItem" | "setItem"> | null;

export function defaultStorage(): MaybeStorage {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
