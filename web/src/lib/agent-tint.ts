/** Avatar tints, picked by agent id so a given agent keeps its colour everywhere.
 * Exported because the picker offers exactly these: a palette the hash cannot
 * produce would be a second palette to explain.
 *
 * Literals, not `var(--accent)` and its friends: a chosen tint is stored, and the
 * BFF accepts a `#rrggbb` literal and nothing else, so a swatch showing a CSS
 * variable was a swatch that could not be saved. */
export const AVATAR_TINTS = ["#9ece6a", "#7aa2f7", "#e0af68", "#bb9af7", "#7dcfff", "#f7768e"];

export function tintFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return AVATAR_TINTS[Math.abs(hash) % AVATAR_TINTS.length] ?? "#7aa2f7";
}

/** The avatar's letter. */
export function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

/** What the user chose for one agent (`bff/src/agents/avatar-prefs.ts`). */
export interface AvatarPref {
  tint?: string;
  glyph?: string;
}

export interface AvatarFace {
  background: string;
  content: string;
}

/**
 * How many graphemes a string would render as — the glyph picker's cap, so a
 * pasted sentence cannot reach a 22px circle. The BFF validates the same rule at
 * the boundary (`bff/src/agents/avatar-prefs.ts`); this one exists only to say
 * "that is too long" while typing.
 */
export function graphemeCount(value: string): number {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length;
  }
  return [...value].length;
}

/**
 * The precedence every avatar surface must agree on: a chosen tint beats the
 * id's hash, a chosen glyph beats the name's initial. With no preference this
 * returns exactly what the avatar was before any of it existed, which is what
 * lets the whole feature ship without touching a single agent.
 */
export function resolveAvatar(id: string, name: string, pref?: AvatarPref): AvatarFace {
  return {
    background: pref?.tint ?? tintFor(id),
    content: pref?.glyph || initialOf(name),
  };
}
