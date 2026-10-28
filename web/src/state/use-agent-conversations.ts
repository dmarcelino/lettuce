import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationSummary } from "./use-agents.ts";
import { readConversations } from "./use-agents.ts";
import type { SessionApi } from "./use-session.ts";

/**
 * One agent's conversations, fetched the first time they are asked for and kept for
 * the life of the page.
 *
 * `use-agents` only ever holds the selected agent's list, so the panel borrowing
 * another agent's list while the pointer rests on their avatar would otherwise draw
 * a `conversation_list` on every hover-in. The cache is a module Map (same
 * last-known pattern as `use-agent-stats`): a hover before the fetch lands shows the
 * loading row, a hover after it is instant, and a failed agent is reported in the
 * panel rather than hanging.
 */
/** How long a cached hover list is trusted: long enough that moving down the rail is
   instant, short enough that a conversation you archived a minute ago is not still there. */
const FRESH_MS = 30_000;

const cache = new Map<string, { at: number; list: ConversationSummary[] }>();

interface AgentConversations {
  conversations: ConversationSummary[];
  loading: boolean;
  failed: boolean;
  load: (agentId: string) => void;
}

export function useAgentConversations(request: SessionApi["request"]): AgentConversations {
  const [state, setState] = useState<{
    agentId: string | null;
    conversations: ConversationSummary[];
    loading: boolean;
    failed: boolean;
  }>({ agentId: null, conversations: [], loading: false, failed: false });
  const inFlight = useRef(new Set<string>());

  const load = useCallback(
    (agentId: string) => {
      const known = cache.get(agentId);
      if (known && Date.now() - known.at < FRESH_MS) {
        setState({ agentId, conversations: known.list, loading: false, failed: false });
        return;
      }
      setState((current) =>
        current.agentId === agentId && current.loading
          ? current
          : { agentId, conversations: [], loading: true, failed: false },
      );
      if (inFlight.current.has(agentId)) return;
      inFlight.current.add(agentId);
      void request("conversation_list", { query: { agent_id: agentId, limit: 100 } })
        .then((response) => {
          const list = readConversations(response);
          cache.set(agentId, { at: Date.now(), list });
          setState((current) =>
            current.agentId === agentId
              ? { agentId, conversations: list, loading: false, failed: false }
              : current,
          );
        })
        .catch(() => {
          setState((current) =>
            current.agentId === agentId
              ? { agentId, conversations: [], loading: false, failed: true }
              : current,
          );
        })
        .finally(() => {
          inFlight.current.delete(agentId);
        });
    },
    [request],
  );

  // The page going away is the cache going away: nothing here outlives a reload.
  useEffect(() => () => inFlight.current.clear(), []);

  return {
    conversations: state.conversations,
    loading: state.loading,
    failed: state.failed,
    load,
  };
}
