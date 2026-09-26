import { useEffect, useState } from "react";
import type { AgentSummary, ConversationSummary } from "./use-agents.ts";
import { readConversations } from "./use-agents.ts";
import type { SessionApi } from "./use-session.ts";

export interface AgentStats {
  /** Non-archived conversations. */
  count: number;
  /** Most recent conversation update, ISO, when any has one. */
  lastActive?: string;
}

export function statsOf(conversations: readonly ConversationSummary[]): AgentStats {
  const live = conversations.filter((c) => !c.archived);
  const lastActive = live
    .map((c) => c.updatedAt)
    .filter((d): d is string => typeof d === "string")
    .sort()
    .at(-1);
  return { count: live.length, ...(lastActive ? { lastActive } : {}) };
}

/**
 * Conversation count and last activity for every agent, for the switcher's
 * agent cards. `use-agents` only ever holds the selected agent's list, so the
 * others are fetched here — once each time the switcher opens (`enabled`), not
 * kept live: a count a few minutes stale on an agent you are not using is fine.
 */
export function useAgentStats(
  request: SessionApi["request"],
  agents: readonly AgentSummary[],
  enabled: boolean,
): ReadonlyMap<string, AgentStats> {
  const [stats, setStats] = useState<ReadonlyMap<string, AgentStats>>(new Map());
  const ids = agents.map((a) => a.id).join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the id list, not the array identity.
  useEffect(() => {
    if (!enabled || !ids) return;
    let cancelled = false;
    void (async () => {
      const next = new Map<string, AgentStats>();
      for (const id of ids.split(",")) {
        try {
          const response = await request("conversation_list", {
            query: { agent_id: id, limit: 100 },
          });
          next.set(id, statsOf(readConversations(response)));
        } catch {
          // A card without a count is better than no switcher.
        }
      }
      if (!cancelled) setStats(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, ids]);

  return stats;
}
