import { parseScopeKey } from "./protocol.ts";
import type { NamedConversation } from "./tasks.ts";

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

/** One responding conversation, as the activity sheet draws it. */
export interface ActivityRow {
  agentId: string;
  /** The agent's name, or its raw id when the agent list does not know it. */
  agentName: string;
  conversationId: string;
  /** The resolved title, or a fallback for the `default` and `unlisted` kinds. */
  title: string;
  /**
   * `default` is the agent's unlistable default conversation (see above) and
   * renders as a note, not a target; `unlisted` is a conversation the fetched
   * list does not contain yet — still switchable.
   */
  kind: "conversation" | "default" | "unlisted";
  isCurrent: boolean;
}

/**
 * Rows for every active scope, for the status dot's activity sheet: current
 * agent first, then agents in list order; within an agent the open
 * conversation first. Titles come from `conversationsByAgent` — the caller
 * merges the current agent's list with lazily fetched ones.
 */
export function activityRows(
  activeScopes: ReadonlySet<string>,
  agents: readonly { id: string; name: string }[],
  currentAgentId: string | null,
  currentConversationId: string | null,
  conversationsByAgent: ReadonlyMap<string, readonly NamedConversation[]>,
): ActivityRow[] {
  const agentRank = new Map(agents.map((agent, index) => [agent.id, index]));
  const rows: ActivityRow[] = [];
  for (const key of activeScopes) {
    const [agentId, conversationId] = parseScopeKey(key);
    const agentName = agents.find((agent) => agent.id === agentId)?.name ?? agentId;
    if (conversationId === DEFAULT_CONVERSATION) {
      rows.push({
        agentId,
        agentName,
        conversationId,
        title: "Default conversation (scheduled or channel turn)",
        kind: "default",
        isCurrent: false,
      });
      continue;
    }
    const listed = conversationsByAgent.get(agentId)?.find((c) => c.id === conversationId);
    rows.push({
      agentId,
      agentName,
      conversationId,
      title: listed?.summary ?? "Conversation (not in list yet)",
      kind: listed ? "conversation" : "unlisted",
      isCurrent: agentId === currentAgentId && conversationId === currentConversationId,
    });
  }
  const rank = (row: ActivityRow): number =>
    row.agentId === currentAgentId ? -1 : (agentRank.get(row.agentId) ?? agents.length);
  return rows.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return 0;
  });
}
