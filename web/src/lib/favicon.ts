import type { LinkState } from "./session-client.ts";

/**
 * A favicon that reports the connection state.
 *
 * On a phone this app spends most of its life in a background tab, which is
 * exactly when the socket drops — so the tab icon is the cheapest place to say
 * whether the agent is still reachable without switching to it.
 *
 * Drawn as an SVG data URI rather than a binary asset: it stays in the bundle,
 * scales at any density, and the tint is a single string swap.
 */

/** Matches the tokens in styles.css. */
const GROUND = "#171a21";
const TINT: Record<LinkState, string> = {
  live: "#7aa2f7", // --accent
  connecting: "#fbbf24", // --warn
  reconnecting: "#fbbf24",
  resyncing: "#fbbf24",
  offline: "#f87171", // --bad
};

function svg(tint: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`,
    `<rect width="64" height="64" rx="14" fill="${GROUND}"/>`,
    // An "L" mark: upright plus foot, in the state colour.
    `<path d="M22 16v32h22" fill="none" stroke="${tint}" stroke-width="8" `,
    `stroke-linecap="round" stroke-linejoin="round"/>`,
    `</svg>`,
  ].join("");
}

export function faviconDataUri(state: LinkState): string {
  return `data:image/svg+xml,${encodeURIComponent(svg(TINT[state] ?? TINT.offline))}`;
}

/**
 * Point the document's icon at the current state. Creates the <link> if the
 * document has none, so this works regardless of what index.html declares.
 */
export function applyFavicon(state: LinkState): void {
  if (typeof document === "undefined") return;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/svg+xml";
  link.href = faviconDataUri(state);
}
