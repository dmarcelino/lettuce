/**
 * Settings → Providers & models: what the operator declares about models
 * behind endpoints that report no capabilities (bff/src/providers/). The
 * declarations drive the providers mod, which is THE capability truth for
 * every prefix it registers, so a save applies from the agents' next turn —
 * no restart. Keys stored on the BFF are write-only: nothing here ever reads
 * one back, and a blank key means "keep the stored one".
 */

export interface ModelCaps {
  vision: boolean;
  thinking: boolean;
  contextWindow: number;
  maxTokens: number;
}

/** "reload-pending": stored, but no agent runtime existed to carry the reload. */
export type ModState = "updated" | "unchanged" | "reload-pending" | "failed" | string;

async function ok(response: Response): Promise<Response> {
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response;
}

/** What the store knows about an endpoint (never the key). */
export interface EndpointInfo {
  baseUrl?: string;
  name?: string;
}

export interface ModelCapsStore {
  models: Record<string, ModelCaps>;
  /** By provider prefix; lets an env-seeded provider render as a served model. */
  endpoints: Record<string, EndpointInfo>;
}

export async function fetchModelCaps(): Promise<ModelCapsStore> {
  const body = (await (await ok(await fetch("/api/model-caps"))).json()) as Partial<ModelCapsStore>;
  return { models: body.models ?? {}, endpoints: body.endpoints ?? {} };
}

export async function saveModelCaps(
  handle: string,
  caps: ModelCaps,
  apiKey?: string,
): Promise<{ mod: ModState }> {
  const response = await ok(
    await fetch("/api/model-caps", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle, ...caps, ...(apiKey ? { apiKey } : {}) }),
    }),
  );
  return (await response.json()) as { mod: ModState };
}

export async function deleteModelCaps(
  handle: string,
): Promise<{ removed: boolean; mod: ModState }> {
  const response = await ok(
    await fetch(`/api/model-caps?handle=${encodeURIComponent(handle)}`, { method: "DELETE" }),
  );
  return (await response.json()) as { removed: boolean; mod: ModState };
}
