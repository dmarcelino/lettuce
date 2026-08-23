import { stripInjectedBlocks } from "./messages.ts";

/**
 * A conversation title derived from the first thing the user said.
 *
 * The app-server never titles a conversation: there is no protocol command for
 * it, and the `autoConversationTitles` setting is only consulted by the TUI.
 * Upstream's own TUI skips model-generated titles on local backends and falls
 * back to exactly this — the first user message, normalised — so this matches
 * its behaviour on this deployment rather than diverging from it.
 *
 * Returns null when there is nothing worth using, which keeps "should this be
 * titled at all" in one place instead of spread across the callers.
 */

/** Upstream's CONVERSATION_TITLE_MAX_LENGTH. */
const MAX_LENGTH = 100;
/** Where a title starts being unwieldy in a narrow sidebar. */
const SOFT_LENGTH = 50;

export function conversationTitle(text: string): string | null {
  // A message can arrive with an environment reminder prepended; titling from
  // that would name every conversation after the same boilerplate.
  const prose = stripInjectedBlocks(text)
    .replace(/\s+/g, " ")
    .trim()
    // Models and users alike wrap titles in quotes; upstream strips them too.
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();

  if (!prose) return null;
  // A slash command is an instruction, not a subject.
  if (prose.startsWith("/")) return null;

  if (prose.length <= SOFT_LENGTH) return prose.slice(0, MAX_LENGTH);

  // Cut on a word boundary so a title never ends mid-word.
  const cut = prose.slice(0, SOFT_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > SOFT_LENGTH / 2 ? cut.slice(0, lastSpace) : cut;
  return `${head.replace(/[,.;:!?-]+$/, "")}…`.slice(0, MAX_LENGTH);
}
