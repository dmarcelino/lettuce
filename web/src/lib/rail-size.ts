/**
 * How tall the rail's agent block is — the one part of the rail a person sizes.
 *
 * The rail itself is a fixed 74px column, but how many agents fit before the
 * block scrolls is nobody's guess but the person with the agents, so the divider
 * between the avatars and the panes drags it. Stored in pixels, the same reason
 * the panel's pin is: it is this browser's layout, not the conversation's, and
 * the app-server has no idea what window it is in.
 */

/** The rail's own width. A card beside an avatar opens past this, not past the
 * avatar, whose right edge sits ~17px inside the rail's border — starting a card
 * there makes it look like a tooltip growing out of the middle of the rail. */
export const RAIL_WIDTH = 74;

const KEY = "lettuc…ckPx";
/** One avatar and its breathing room: below this the block is a slot, not a list. */
export const AGENT_BLOCK_MIN = 46;
/** The pane items, the separator and the footer: what the block can never crowd out. */
const PANE_ROOM = 330;

/** The tallest the agent block can be in a window this tall. */
export function agentBlockMax(viewportHeight: number): number {
  return Math.max(AGENT_BLOCK_MIN, viewportHeight - PANE_ROOM);
}

/** Keeps a dragged or stored height inside what the window can show. */
export function clampAgentBlock(px: number, viewportHeight: number): number {
  return Math.min(Math.max(px, AGENT_BLOCK_MIN), agentBlockMax(viewportHeight));
}

/** `null` means never dragged: the stylesheet's own default holds. */
export function readAgentBlock(): number | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const px = Number(raw);
    return Number.isFinite(px) ? px : null;
  } catch {
    return null;
  }
}

export function writeAgentBlock(px: number): void {
  try {
    localStorage.setItem(KEY, String(Math.round(px)));
  } catch {
    // A private mode that refuses storage is not worth failing a drag over.
  }
}

/** Home: back to the stylesheet's own default, which is what "never dragged" means. */
export function clearAgentBlock(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Same as above.
  }
}
