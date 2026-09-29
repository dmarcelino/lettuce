/** Avatar tints, picked by agent id so a given agent keeps its colour everywhere. */
const AVATAR_TINTS = ["var(--agent)", "var(--accent)", "#e0af68", "#bb9af7", "#7dcfff", "#f7768e"];

export function tintFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return AVATAR_TINTS[Math.abs(hash) % AVATAR_TINTS.length] ?? "var(--accent)";
}

/** The avatar's letter. */
export function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}
