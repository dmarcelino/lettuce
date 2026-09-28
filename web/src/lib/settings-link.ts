/**
 * `?settings=<section>` opens Settings on that section — the link an agent
 * hands the user when Google access is lost (`bff/src/google/lost-access.ts`),
 * and where the OAuth result page sends them back. Read once on load, then
 * stripped like the conversation deep link (`selection.ts`), so a refresh does
 * not reopen it.
 */
import type { DeepLinkHistory, DeepLinkLocation } from "./selection.ts";

export function readSettingsDeepLink<T extends string>(
  isSection: (value: string) => value is T,
  location: DeepLinkLocation = window.location,
  history: DeepLinkHistory = window.history,
): T | null {
  try {
    const params = new URLSearchParams(location.search);
    const value = params.get("settings");
    if (value === null) return null;
    params.delete("settings");
    const rest = params.toString();
    history.replaceState(null, "", rest ? `?${rest}` : location.pathname);
    return isSection(value) ? value : null;
  } catch {
    return null;
  }
}
