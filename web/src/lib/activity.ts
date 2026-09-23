/**
 * Where an agent's in-progress responses are, relative to the conversation
 * list the sidebar can draw.
 *
 * A busy scope does not always have a row to put a dot on:
 * - `"default"` is the agent's own conversation. Cron tasks with no target
 *   conversation run there (letta-code `cron/scheduler.ts`), and
 *   `conversation_list` never returns it — nor can its history be read by that
 *   id — so it can only ever be mentioned, not listed.
 * - A conversation created after the list was fetched — a cron set to start a
 *   new conversation per run — is simply not in the list yet.
 * - An archived conversation is in the list but hidden unless asked for.
 */
export const DEFAULT_CONVERSATION = "default";

export interface AgentActivity {
  /** Conversation ids of this agent with a response in progress. */
  responding: ReadonlySet<string>;
  /** The agent's unlisted default conversation is responding. */
  inDefault: boolean;
  /** Responding conversations the list does not contain at all (excluding default). */
  unlisted: string[];
}

/** `activeScopes` holds `scopeKey`s: `<agent_id>::<conversation_id>`. */
export function agentActivity(
  activeScopes: ReadonlySet<string>,
  agentId: string | null,
  listedIds: readonly string[],
): AgentActivity {
  const responding = new Set<string>();
  if (agentId) {
    const prefix = `${agentId}::`;
    for (const key of activeScopes) {
      if (key.startsWith(prefix)) responding.add(key.slice(prefix.length));
    }
  }
  const listed = new Set(listedIds);
  const unlisted = [...responding].filter((id) => id !== DEFAULT_CONVERSATION && !listed.has(id));
  return { responding, inDefault: responding.has(DEFAULT_CONVERSATION), unlisted };
}
