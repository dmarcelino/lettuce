/**
 * Which agent and conversation the browser was last looking at.
 *
 * Without this a reload always landed on whichever agent `agent_list` returned
 * first — so the phone came back to "Assistant" every time, no matter which
 * agent you were mid-conversation with.
 *
 * The pair is stored as ONE record on purpose. A conversation belongs to an
 * agent, and two independent keys can be written at different moments, which is
 * how you end up restoring a conversation id that belongs to a different agent.
 */
export interface Selection {
  agentId: string | null;
  conversationId: string | null;
}

const KEY = "letta-ui:selection";

export const EMPTY_SELECTION: Selection = { agentId: null, conversationId: null };

/**
 * A `Storage` this module is allowed to fail on.
 *
 * `localStorage` is not always there to be had: Safari's private mode has
 * historically thrown on write, an embedded webview can disable it outright,
 * and reading it from a sandboxed frame throws on *access*, before any method
 * is called. Remembering a selection is a convenience, so every path here
 * degrades to "no memory" rather than taking the app down with it.
 */
type MaybeStorage = Pick<Storage, "getItem" | "setItem"> | null;

function defaultStorage(): MaybeStorage {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The last selection, or empty when there is none to be had. */
export function readSelection(storage: MaybeStorage = defaultStorage()): Selection {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return EMPTY_SELECTION;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY_SELECTION;
    const record = parsed as { agentId?: unknown; conversationId?: unknown };
    return {
      agentId: typeof record.agentId === "string" ? record.agentId : null,
      conversationId: typeof record.conversationId === "string" ? record.conversationId : null,
    };
  } catch {
    // Corrupt JSON, or storage that throws on access. Either way: start fresh.
    return EMPTY_SELECTION;
  }
}

/** Remember a selection. Silently does nothing when storage is unavailable. */
export function writeSelection(
  selection: Selection,
  storage: MaybeStorage = defaultStorage(),
): void {
  try {
    storage?.setItem(KEY, JSON.stringify(selection));
  } catch {
    // Quota, private mode, disabled storage — none of it is worth an error.
  }
}
