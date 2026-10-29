/**
 * Pinned agents come first in every agent list, in the order they were
 * pinned; the rest keep the order `agent_list` gave. Archived agents are
 * hidden until asked for. Both are kept by the BFF
 * (`bff/src/agents/id-list.ts`) so every device agrees.
 */

import type { AvatarPref } from "./agent-tint.ts";

export interface AgentFlags {
  pinned: string[];
  archived: string[];
  /**
   * Per-agent avatar choices, keyed by agent id, present only for agents that
   * chose something (`bff/src/agents/avatar-prefs.ts`). Optional because a BFF
   * from before it answers without the field, which is the same as nothing
   * chosen.
   */
  avatars?: Record<string, AvatarPref>;
}

export function orderByPins<T extends { id: string }>(
  agents: readonly T[],
  pinned: readonly string[],
): T[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const first = pinned.flatMap((id) => {
    const agent = byId.get(id);
    return agent ? [agent] : [];
  });
  const pinnedSet = new Set(pinned);
  return [...first, ...agents.filter((agent) => !pinnedSet.has(agent.id))];
}

export async function fetchAgentFlags(): Promise<AgentFlags> {
  const response = await fetch("/api/agents/flags");
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return (await response.json()) as AgentFlags;
}

/** Archiving also unpins, server-side; both lists come back. */
export async function saveArchivedAgent(agentId: string, archived: boolean): Promise<AgentFlags> {
  const response = await fetch(`/api/agents/archived/${encodeURIComponent(agentId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived }),
  });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return (await response.json()) as AgentFlags;
}

export async function savePinnedAgent(agentId: string, pinned: boolean): Promise<string[]> {
  const response = await fetch(`/api/agents/pins/${encodeURIComponent(agentId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned }),
  });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return ((await response.json()) as { pinned: string[] }).pinned;
}

/**
 * Writes one agent's avatar choice and returns the whole map, so one write can
 * refresh every list that shows an avatar. An empty pref resets that agent to the
 * tint and initial it derives on its own.
 */
export async function saveAgentAvatar(
  agentId: string,
  pref: { tint?: string | null; glyph?: string | null },
): Promise<Record<string, AvatarPref>> {
  const response = await fetch(`/api/agents/avatar/${encodeURIComponent(agentId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pref),
  });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return ((await response.json()) as { avatars: Record<string, AvatarPref> }).avatars;
}
