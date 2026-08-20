import { useCallback, useEffect, useState } from "react";
import type { SessionApi } from "./use-session.ts";

export interface AgentSummary {
  id: string;
  name: string;
}

export interface ConversationSummary {
  id: string;
  summary: string;
  archived: boolean;
  updatedAt?: string;
}

function readAgents(response: unknown): AgentSummary[] {
  const agents = (response as { agents?: unknown })?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const agent = raw as { id?: unknown; name?: unknown };
    if (typeof agent.id !== "string") return [];
    return [{ id: agent.id, name: typeof agent.name === "string" ? agent.name : agent.id }];
  });
}

function readConversations(response: unknown): ConversationSummary[] {
  const conversations = (response as { conversations?: unknown })?.conversations;
  if (!Array.isArray(conversations)) return [];
  return conversations.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const conversation = raw as {
      id?: unknown;
      summary?: unknown;
      archived?: unknown;
      updated_at?: unknown;
    };
    if (typeof conversation.id !== "string") return [];
    return [
      {
        id: conversation.id,
        summary:
          typeof conversation.summary === "string" && conversation.summary.trim()
            ? conversation.summary
            : "Untitled",
        archived: conversation.archived === true,
        ...(typeof conversation.updated_at === "string"
          ? { updatedAt: conversation.updated_at }
          : {}),
      },
    ];
  });
}

export interface AgentsApi {
  agents: AgentSummary[];
  conversations: ConversationSummary[];
  agentId: string | null;
  conversationId: string | null;
  loading: boolean;
  error: string | null;
  selectAgent: (agentId: string) => void;
  selectConversation: (conversationId: string) => void;
  refreshAgents: () => Promise<void>;
  refreshConversations: (agentId: string) => Promise<void>;
  createConversation: () => Promise<void>;
  renameConversation: (conversationId: string, summary: string) => Promise<void>;
  setArchived: (conversationId: string, archived: boolean) => Promise<void>;
}

export function useAgents(session: SessionApi): AgentsApi {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAgents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await session.request("agent_list", { query: { limit: 100 } });
      const list = readAgents(response);
      setAgents(list);
      setAgentId((current) => current ?? list[0]?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [session]);

  const refreshConversations = useCallback(
    async (targetAgentId: string) => {
      setError(null);
      try {
        const response = await session.request("conversation_list", {
          query: { agent_id: targetAgentId, limit: 100 },
        });
        const list = readConversations(response);
        setConversations(list);
        setConversationId((current) => {
          if (current && list.some((c) => c.id === current)) return current;
          const active = list.find((c) => !c.archived);
          return active?.id ?? list[0]?.id ?? null;
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [session],
  );

  useEffect(() => {
    if (session.ready) void refreshAgents();
  }, [session.ready, refreshAgents]);

  useEffect(() => {
    if (session.ready && agentId) void refreshConversations(agentId);
  }, [session.ready, agentId, refreshConversations]);

  const selectAgent = useCallback((next: string) => {
    setAgentId(next);
    setConversationId(null);
    setConversations([]);
  }, []);

  const createConversation = useCallback(async () => {
    if (!agentId) return;
    const response = await session.request<{ conversation?: { id?: string } }>(
      "conversation_create",
      { body: { agent_id: agentId } },
    );
    await refreshConversations(agentId);
    const id = response?.conversation?.id;
    if (typeof id === "string") setConversationId(id);
  }, [agentId, session, refreshConversations]);

  const renameConversation = useCallback(
    async (target: string, summary: string) => {
      await session.request("conversation_update", {
        conversation_id: target,
        body: { summary },
      });
      if (agentId) await refreshConversations(agentId);
    },
    [agentId, session, refreshConversations],
  );

  // `conversation_list` ignores an `archived` query filter, so the archived
  // set is filtered client-side; only the write side is native.
  const setArchived = useCallback(
    async (target: string, archived: boolean) => {
      await session.request("conversation_update", {
        conversation_id: target,
        body: { archived },
      });
      if (agentId) await refreshConversations(agentId);
    },
    [agentId, session, refreshConversations],
  );

  return {
    agents,
    conversations,
    agentId,
    conversationId,
    loading,
    error,
    selectAgent,
    selectConversation: setConversationId,
    refreshAgents,
    refreshConversations,
    createConversation,
    renameConversation,
    setArchived,
  };
}
