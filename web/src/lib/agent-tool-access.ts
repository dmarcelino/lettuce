/**
 * Which shared tool families one agent may use — Codex workers and Google.
 * Kept and enforced by the BFF (`bff/src/agents/tool-access.ts`).
 */

export type GoogleAccess = "full" | "read" | "off";

export interface AgentToolAccess {
  codex: boolean;
  google: GoogleAccess;
}

/** What the save did to the mods: "failed" means saved but not yet live. */
export type ModsResult = "unchanged" | "reloaded" | "reload-pending" | "failed";

export async function fetchAgentToolAccess(agentId: string): Promise<AgentToolAccess> {
  const response = await fetch(`/api/agents/tool-access/${encodeURIComponent(agentId)}`);
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return (await response.json()) as AgentToolAccess;
}

export async function saveAgentToolAccess(
  agentId: string,
  access: AgentToolAccess,
): Promise<AgentToolAccess & { mods: ModsResult }> {
  const response = await fetch(`/api/agents/tool-access/${encodeURIComponent(agentId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(access),
  });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return (await response.json()) as AgentToolAccess & { mods: ModsResult };
}
