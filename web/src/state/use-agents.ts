import { useCallback, useEffect, useState } from "react";
import { readAgentModelHandle } from "./use-models.ts";
import type { SessionApi } from "./use-session.ts";

export interface AgentSummary {
  id: string;
  name: string;
}

/** The only personalities `create_agent` accepts. There is no "default". */
export const AGENT_PRESETS = ["memo", "tutorial", "blank", "linus", "kawaii"] as const;
export type AgentPreset = (typeof AGENT_PRESETS)[number];

export interface AgentDetail {
  id: string;
  name: string;
  system: string;
  modelHandle: string | null;
}

export interface AgentDraft {
  name: string;
  system: string;
  modelHandle: string | null;
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

/**
 * The app-server answers a rejected command with `success: false` rather than
 * closing the request, so a failure is only visible if we look for it.
 */
function assertOk(response: unknown, fallback: string): void {
  const result = response as { success?: unknown; error?: unknown } | null;
  if (result?.success === false) {
    throw new Error(typeof result.error === "string" ? result.error : fallback);
  }
}

function readAgentDetail(id: string, raw: unknown): AgentDetail {
  const agent = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    id: typeof agent.id === "string" ? agent.id : id,
    name: typeof agent.name === "string" ? agent.name : id,
    system: typeof agent.system === "string" ? agent.system : "",
    modelHandle: readAgentModelHandle(agent),
  };
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
  retrieveAgent: (agentId: string) => Promise<AgentDetail>;
  createAgent: (preset: AgentPreset, draft: AgentDraft) => Promise<void>;
  updateAgent: (agentId: string, draft: AgentDraft) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  createConversation: () => Promise<void>;
  renameConversation: (conversationId: string, summary: string) => Promise<void>;
  setArchived: (conversationId: string, archived: boolean) => Promise<void>;
}

export function useAgents(session: SessionApi): AgentsApi {
  const { request, ready } = session;
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
      const response = await request("agent_list", { query: { limit: 100 } });
      const list = readAgents(response);
      setAgents(list);
      setAgentId((current) => current ?? list[0]?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [request]);

  const refreshConversations = useCallback(
    async (targetAgentId: string) => {
      setError(null);
      try {
        const response = await request("conversation_list", {
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
    [request],
  );

  useEffect(() => {
    if (ready) void refreshAgents();
  }, [ready, refreshAgents]);

  useEffect(() => {
    if (ready && agentId) void refreshConversations(agentId);
  }, [ready, agentId, refreshConversations]);

  const selectAgent = useCallback((next: string) => {
    setAgentId(next);
    setConversationId(null);
    setConversations([]);
  }, []);

  const retrieveAgent = useCallback(
    async (target: string) => {
      const response = await request<{ agent?: unknown }>("agent_retrieve", {
        agent_id: target,
      });
      assertOk(response, "Failed to load agent");
      return readAgentDetail(target, response?.agent);
    },
    [request],
  );

  /**
   * Model changes go through `update_model` scoped to the sentinel conversation
   * `"default"`, which the app-server treats as "the agent itself" and answers
   * with `applied_to: "agent"`. That path preserves the context window and
   * infers `provider_type` for OpenAI-compatible proxies; writing
   * `agent_update {model}` directly would skip all of it.
   */
  const applyAgentModel = useCallback(
    async (target: string, modelHandle: string) => {
      const response = await request("update_model", {
        runtime: { agent_id: target, conversation_id: "default" },
        payload: { model_id: modelHandle, model_handle: modelHandle },
      });
      assertOk(response, "Failed to set the model");
    },
    [request],
  );

  const createAgent = useCallback(
    async (preset: AgentPreset, draft: AgentDraft) => {
      const response = await request<{ agent_id?: string; name?: string }>("create_agent", {
        personality: preset,
        ...(draft.modelHandle ? { model: draft.modelHandle } : {}),
      });
      assertOk(response, "Failed to create the agent");

      const created = response?.agent_id;
      if (typeof created !== "string") throw new Error("Agent was created without an id");

      // The preset names the agent; apply the user's own name and prompt after.
      const body: Record<string, unknown> = {};
      if (draft.name.trim() && draft.name.trim() !== response?.name) body.name = draft.name.trim();
      if (draft.system.trim()) body.system = draft.system;
      if (Object.keys(body).length > 0) {
        assertOk(
          await request("agent_update", { agent_id: created, body }),
          "Agent created, but its name could not be applied",
        );
      }

      await refreshAgents();
      setAgentId(created);
      setConversationId(null);
      setConversations([]);
    },
    [request, refreshAgents],
  );

  const updateAgent = useCallback(
    async (target: string, draft: AgentDraft) => {
      const response = await request("agent_update", {
        agent_id: target,
        body: { name: draft.name.trim(), system: draft.system },
      });
      assertOk(response, "Failed to update the agent");
      if (draft.modelHandle) await applyAgentModel(target, draft.modelHandle);
      await refreshAgents();
    },
    [request, refreshAgents, applyAgentModel],
  );

  const deleteAgent = useCallback(
    async (target: string) => {
      const response = await request("agent_delete", { agent_id: target });
      assertOk(response, "Failed to delete the agent");

      // `refreshAgents` only fills an empty selection, so a deleted *current*
      // agent has to be cleared first or the UI keeps pointing at a dead id.
      setAgents((current) => {
        const remaining = current.filter((agent) => agent.id !== target);
        setAgentId((selected) => (selected === target ? (remaining[0]?.id ?? null) : selected));
        return remaining;
      });
      setConversationId(null);
      setConversations([]);
      await refreshAgents();
    },
    [request, refreshAgents],
  );

  const createConversation = useCallback(async () => {
    if (!agentId) return;
    const response = await request<{ conversation?: { id?: string } }>("conversation_create", {
      body: { agent_id: agentId },
    });
    await refreshConversations(agentId);
    const id = response?.conversation?.id;
    if (typeof id === "string") setConversationId(id);
  }, [agentId, request, refreshConversations]);

  const renameConversation = useCallback(
    async (target: string, summary: string) => {
      await request("conversation_update", {
        conversation_id: target,
        body: { summary },
      });
      if (agentId) await refreshConversations(agentId);
    },
    [agentId, request, refreshConversations],
  );

  // `conversation_list` ignores an `archived` query filter, so the archived
  // set is filtered client-side; only the write side is native.
  const setArchived = useCallback(
    async (target: string, archived: boolean) => {
      await request("conversation_update", {
        conversation_id: target,
        body: { archived },
      });
      if (agentId) await refreshConversations(agentId);
    },
    [agentId, request, refreshConversations],
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
    retrieveAgent,
    createAgent,
    updateAgent,
    deleteAgent,
    createConversation,
    renameConversation,
    setArchived,
  };
}
