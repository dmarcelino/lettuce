import { useCallback, useEffect, useState } from "react";
import type { SessionApi } from "./use-session.ts";

/**
 * letta-code's context window for an OpenAI-compatible model it cannot size:
 * a fixed conservative default (LOCAL_ENDPOINT_DEFAULT_CONTEXT_WINDOW), not
 * what the server actually serves. `/context-limit` overrides it.
 */
export const LETTA_DEFAULT_CONTEXT_LIMIT = 128_000;
/** Below this, letta-code refuses a limit without --override; we refuse outright. */
export const MIN_CONTEXT_LIMIT = 30_000;

export type LimitSource = "conversation" | "agent" | "default";

export interface ContextLimit {
  tokens: number;
  /** Where the effective value is set — the conversation's own wins over the agent's. */
  source: LimitSource;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** The effective limit, resolved the way letta-code does: conversation, agent, default. */
export function resolveContextLimit(agent: unknown, conversation: unknown): ContextLimit {
  const conv = (conversation ?? {}) as { context_window_limit?: unknown };
  const own = positive(conv.context_window_limit);
  if (own !== null) return { tokens: own, source: "conversation" };
  const a = (agent ?? {}) as {
    model_settings?: { context_window_limit?: unknown };
    llm_config?: { context_window?: unknown };
  };
  const agentLimit =
    positive(a.model_settings?.context_window_limit) ?? positive(a.llm_config?.context_window);
  if (agentLimit !== null) return { tokens: agentLimit, source: "agent" };
  return { tokens: LETTA_DEFAULT_CONTEXT_LIMIT, source: "default" };
}

/**
 * "262144", "262,144", "256k" → tokens; null when it is not a number. A bare
 * "k" is thousands of 1024 only when it reads as a power-of-two size (128k,
 * 256k), because that is how llama.cpp contexts are configured.
 */
export function parseContextLimit(text: string): number | null {
  const trimmed = text.trim().toLowerCase().replaceAll(",", "").replaceAll("_", "");
  const match = /^(\d+(?:\.\d+)?)\s*(k)?$/.exec(trimmed);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  if (!match[2]) return Math.round(value);
  return Number.isInteger(Math.log2(value)) ? value * 1024 : Math.round(value * 1000);
}

export interface ContextLimitApi {
  limit: ContextLimit | null;
  refresh: () => Promise<void>;
  /**
   * Set (`tokens`) or reset (`null`) the limit for this conversation or the
   * whole agent, through letta-code's own `/context-limit`. The agent scope is
   * the agent's `default` conversation — how letta-code applies agent-wide
   * settings. Resolves with the command's own confirmation.
   */
  apply: (tokens: number | null, scope: "conversation" | "agent") => Promise<string>;
}

export function useContextLimit(
  request: SessionApi["request"],
  agentId: string | null,
  conversationId: string | null,
): ContextLimitApi {
  const [limit, setLimit] = useState<ContextLimit | null>(null);

  const refresh = useCallback(async () => {
    if (!agentId) {
      setLimit(null);
      return;
    }
    const [agent, conversation] = await Promise.all([
      request<{ agent?: unknown }>("agent_retrieve", { agent_id: agentId }).catch(() => null),
      conversationId && conversationId !== "default"
        ? request<{ conversation?: unknown }>("conversation_retrieve", {
            conversation_id: conversationId,
          }).catch(() => null)
        : Promise.resolve(null),
    ]);
    setLimit(resolveContextLimit(agent?.agent, conversation?.conversation));
  }, [request, agentId, conversationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apply = useCallback(
    async (tokens: number | null, scope: "conversation" | "agent") => {
      if (!agentId || (scope === "conversation" && !conversationId)) {
        throw new Error("No conversation is open");
      }
      const response = await request<{ success?: boolean; error?: string; output?: string }>(
        "execute_command",
        {
          runtime: {
            agent_id: agentId,
            conversation_id: scope === "agent" ? "default" : conversationId,
          },
          command_id: "context-limit",
          // --override: letta-code refuses anything above its 128k default
          // without it, which is exactly the case this exists for.
          ...(tokens === null ? {} : { args: `${tokens} --override` }),
        },
      );
      if (response?.success === false) {
        throw new Error(response.error ?? "Could not change the context limit");
      }
      await refresh();
      return response?.output ?? "";
    },
    [request, agentId, conversationId, refresh],
  );

  return { limit, refresh, apply };
}
