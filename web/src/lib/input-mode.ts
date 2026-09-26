/**
 * Whether Enter sends the message.
 *
 * On a phone the on-screen keyboard's Enter is where people reach for a new
 * line, and an accidental send cannot be taken back — so there Enter is a
 * newline and only the send button sends. A touch-first device is one whose
 * primary pointer is coarse and cannot hover; a laptop with a touchscreen
 * still reports a fine, hovering primary pointer and keeps Enter-to-send.
 */
export function enterSends(
  matchMedia: ((query: string) => { matches: boolean }) | undefined = globalThis.matchMedia?.bind(
    globalThis,
  ),
): boolean {
  if (!matchMedia) return true;
  return !matchMedia("(hover: none) and (pointer: coarse)").matches;
}
