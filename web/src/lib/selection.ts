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
import { defaultStorage, type MaybeStorage } from "./storage.ts";

export interface Selection {
  agentId: string | null;
  conversationId: string | null;
}

const KEY = "letta-ui:selection";

export const EMPTY_SELECTION: Selection = { agentId: null, conversationId: null };

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

export interface DeepLinkLocation {
  pathname: string;
  search: string;
}

export interface DeepLinkHistory {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

/**
 * A push notification deep-links into a conversation via `?agent=&conversation=`
 * query params (there is no router in this app — see `sw.ts`'s
 * `notificationclick`, which forces a real navigation to carry them). Read
 * once at the same mount point `readSelection` used to own: a deep link wins
 * over the persisted selection for this one read, and the params are then
 * stripped so a refresh or a shared link doesn't keep re-landing on it.
 */
export function readDeepLinkSelection(
  storage: MaybeStorage = defaultStorage(),
  location: DeepLinkLocation = window.location,
  history: DeepLinkHistory = window.history,
): Selection {
  let deepLink: Selection | null = null;
  try {
    const params = new URLSearchParams(location.search);
    const agentId = params.get("agent");
    const conversationId = params.get("conversation");
    if (agentId || conversationId) {
      deepLink = { agentId, conversationId };
      params.delete("agent");
      params.delete("conversation");
      const rest = params.toString();
      history.replaceState(null, "", rest ? `?${rest}` : location.pathname);
    }
  } catch {
    // A history API that throws (an embedded webview, a sandboxed frame) is
    // no worse than no deep link at all — the deep link itself, if already
    // parsed, is still returned below.
  }
  return deepLink ?? readSelection(storage);
}
