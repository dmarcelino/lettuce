import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationSummary } from "./use-agents.ts";
import { readConversations } from "./use-agents.ts";
import type { SessionApi } from "./use-session.ts";

/**
 * One agent's conversations, fetched the first time it is asked for and kept for
 * the life of the page.
 *
 * `use-agents` only ever holds the selected agent's list, so the rail's hover
 * card would otherwise draw a `conversation_list` on every hover-in. The cache
 * is a module Map (same last-known pattern as `use-agent-stats`): a hover
 * before the fetch lands shows the loading state, a hover after it is instant,
 * and a failed agent is simply absent — the card says so rather than hanging.
 */
const cache = new Map<string, ConversationSummary[]>();

interface AgentConversations {
  conversations: ConversationSummary[];
  loading: boolean;
  failed: boolean;
  /** Drop the cached list so the next `load` refetches (a new conversation appears). */
  invalidate: (agentId: string) => void;
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
      if (known) {
        setState({ agentId, conversations: known, loading: false, failed: false });
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
          cache.set(agentId, list);
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

  const invalidate = useCallback((agentId: string) => {
    cache.delete(agentId);
  }, []);

  // A cache written by someone else (the switcher refreshing after a new
  // conversation) should win on the next hover, so nothing here goes stale.
  useEffect(() => {
    return () => {
      inFlight.current.clear();
    };
  }, []);

  return {
    conversations: state.conversations,
    loading: state.loading,
    failed: state.failed,
    invalidate,
    load,
  };
}
