/**
 * Why a WebSocket will not open.
 *
 * A refused upgrade reaches the browser as close code 1006 with no status, the
 * same code as being offline — so the client retried forever and sat on
 * "Reconnecting…" after a login expired, until a manual reload. An ordinary
 * fetch *does* show what is in the way:
 *
 * - `expired`: Cloudflare Access answered instead of the app — its redirect to
 *   the login page (`opaqueredirect` under `redirect: "manual"`) or a 401/403 —
 *   or the app itself says nobody is signed in. Only a top-level navigation can
 *   get through Access's login, so the fix is a reload.
 * - `ok`: the server is reachable and this browser is signed in. In Access mode
 *   the probe itself re-mints an expired app cookie, so the next attempt works.
 * - `unreachable`: offline, or the server is down. Keep retrying.
 */
import { type MaybeStorage, readStored } from "./storage.ts";

export type AuthProbe = "ok" | "expired" | "unreachable";

export interface ProbeResponse {
  type: string;
  status: number;
  json: () => Promise<unknown>;
}

export async function classifyAuthProbe(response: ProbeResponse): Promise<AuthProbe> {
  if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) {
    return "expired";
  }
  if (response.status < 200 || response.status >= 300) return "unreachable";
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A 200 that is not our JSON is someone else's page — Access's login form
    // served in place, say. Not signed in to us, either way.
    return "expired";
  }
  return (body as { authenticated?: unknown } | null)?.authenticated === true ? "ok" : "expired";
}

export async function probeAuth(fetchImpl: typeof fetch = fetch): Promise<AuthProbe> {
  let response: Response;
  try {
    response = await fetchImpl("/api/status", { redirect: "manual", cache: "no-store" });
  } catch {
    return "unreachable";
  }
  return classifyAuthProbe(response);
}

const RELOAD_KEY = "lettuce:reauth-reload-at";
/** An automatic re-sign-in reload happens at most this often. */
export const AUTO_RELOAD_INTERVAL_MS = 5 * 60_000;

/**
 * Whether to reload on our own now, recording it when the answer is yes.
 *
 * The reload is what takes the browser through Access's login. If it comes
 * straight back still signed out, reloading again would loop, so within the
 * interval the app shows a "Sign in again" button instead.
 */
export function claimAutoReload(storage: MaybeStorage, now: number = Date.now()): boolean {
  // Without storage there is no loop guard, so never reload unasked.
  if (!storage) return false;
  try {
    const stamp = readStored(storage, RELOAD_KEY);
    const last = stamp === null ? Number.NaN : Number(stamp);
    if (Number.isFinite(last) && now - last < AUTO_RELOAD_INTERVAL_MS) return false;
    storage.setItem(RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}
