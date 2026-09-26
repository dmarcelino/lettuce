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
 * Every agent's stats, fetched in parallel. An agent whose lookup fails is
 * simply absent: a card without a count is better than no switcher.
 */
export async function fetchAgentStats(
  request: SessionApi["request"],
  agentIds: readonly string[],
): Promise<Map<string, AgentStats>> {
  const results = await Promise.all(
    agentIds.map(async (id) => {
      try {
        const response = await request("conversation_list", {
          query: { agent_id: id, limit: 100 },
        });
        return [id, statsOf(readConversations(response))] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(results.filter((entry): entry is readonly [string, AgentStats] => entry !== null));
}

/**
 * The last stats fetched, kept for the life of the page — NOT the switcher.
 * The switcher unmounts on close, so stats held in its own state were thrown
 * away and every open drew the agent cards without their counts first, then
 * grew them a round trip later: the agents panel jumped. Reopening now starts
 * from these and refreshes them quietly.
 */
let lastKnown: ReadonlyMap<string, AgentStats> = new Map();

/**
 * Conversation count and last activity for every agent, for the switcher's
 * agent cards. `use-agents` only ever holds the selected agent's list, so the
 * others are fetched here — each time the switcher opens (`enabled`), in
 * parallel, applied in one update, over the last known values.
 */
export function useAgentStats(
  request: SessionApi["request"],
  agents: readonly AgentSummary[],
  enabled: boolean,
): ReadonlyMap<string, AgentStats> {
  const [stats, setStats] = useState<ReadonlyMap<string, AgentStats>>(lastKnown);
  const ids = agents.map((a) => a.id).join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the id list, not the array identity.
  useEffect(() => {
    if (!enabled || !ids) return;
    let cancelled = false;
    void fetchAgentStats(request, ids.split(",")).then((fresh) => {
      // Keep a last-known value for an agent whose refresh failed.
      const merged = new Map(lastKnown);
      for (const [id, value] of fresh) merged.set(id, value);
      lastKnown = merged;
      if (!cancelled) setStats(merged);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, ids]);

  return stats;
}
