/**
 * The minimum a task target needs to be named. Structural rather than
 * `ConversationSummary` so `lib/` does not depend on `state/` — the summary
 * type satisfies it as-is.
 */
export interface NamedConversation {
  id: string;
  summary: string;
}

/**
 * Upstream's sentinel for "no fixed conversation": every fire creates a fresh
 * one. `cron-file.ts` (AddTaskInput) documents the three shapes —
 * omitted/"new" = fresh conversation per fire, "default" = the agent's default
 * conversation, anything else = that existing conversation id.
 *
 * `cron_update` assigns the field whenever it is present, so the sentinel can
 * be sent on edit too: a task is not stuck on whatever it was created with.
 */
export const NEW_CONVERSATION = "new";

/**
 * Human name for a task's conversation target.
 *
 * A known conversation resolves to its title. An unknown id is shown
 * truncated rather than hidden — a task aimed at a conversation you cannot see
 * is worse than an ugly id.
 */
export function conversationTargetLabel(
  conversationId: string | null | undefined,
  conversations: readonly NamedConversation[],
): string {
  if (!conversationId || conversationId === NEW_CONVERSATION) {
    return "New conversation each run";
  }
  if (conversationId === "default") return "Default conversation";
  const known = conversations.find((conversation) => conversation.id === conversationId);
  if (known) return known.summary;
  return `Conversation ${conversationId.slice(0, 12)}…`;
}
