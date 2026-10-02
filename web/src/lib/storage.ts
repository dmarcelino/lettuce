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

/**
 * The prefix every key carried before the app was called letta-ui. Kept only so
 * a device that already has this app's keys keeps its drafts and preferences
 * through the rename; a key is copied forward the first time it is read and the
 * old entry is left alone (harmless, and it makes a rollback cheap).
 */
const LEGACY_PREFIX = "letta-ui:";

/**
 * `getItem` for a `lettuce:`-prefixed key, migrating a stored value forward
 * from the pre-rename name when the new one is not there yet.
 *
 * Never throws: everything built on these keys is a convenience, and the
 * browser can throw on merely touching `localStorage`.
 */
export function readStored(storage: MaybeStorage, key: string): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(key);
    if (value !== null) return value;
    if (!key.startsWith("lettuce:")) return null;
    const legacy = storage.getItem(LEGACY_PREFIX + key.slice("lettuce:".length));
    if (legacy === null) return null;
    try {
      storage.setItem(key, legacy);
    } catch {
      /* a store that cannot write keeps working read-only from the legacy key */
    }
    return legacy;
  } catch {
    return null;
  }
}
