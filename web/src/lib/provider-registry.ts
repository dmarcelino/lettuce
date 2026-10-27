import type { ModState } from "./model-caps.ts";

/**
 * Settings → Providers & models: the providers the operator added.
 *
 * Each is a named endpoint with a handle prefix of its own, registered by the BFF
 * (`bff/src/providers/registry.ts`). The name is the identity — `llama 3b`
 * becomes `llama-3b/<model>` — so two providers may share a type but never a
 * name. A key is write-only: it is sent on save and never read back, so an edit
 * that leaves the field blank keeps the stored one.
 */

export interface ProviderType {
  id: string;
  label: string;
  scope: "local" | "cloud";
  /** The pi-ai api the endpoint speaks; shown so a type is more than a name. */
  api: string;
  /** Prefilled base URL, still editable. */
  baseUrl: string;
  keyOptional: boolean;
  /**
   * Set when the app-server's own connection serves this type: its catalog names
   * models `vendor/model`, which a provider you name cannot register. A save
   * connects it, one per type, with this id as its handle prefix.
   */
  connection?: string;
}

export interface Provider {
  prefix: string;
  name: string;
  /** Catalog type id; empty for a provider declared model-by-model. */
  type: string;
  api: string;
  scope: "local" | "cloud";
  baseUrl: string;
  models: string[];
  hasKey: boolean;
  /** Stored custom-header names. Values are write-only, like the key. */
  headerNames: string[];
  /** Why it serves nothing (or less than it lists), when it does. */
  problem?: string;
}

export interface ProviderDraft {
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  /**
   * The complete header set, sent only when the form touched headers at all
   * (`undefined` keeps the stored set, like a blank key keeps the stored one).
   */
  headers?: Record<string, string>;
}

async function ok(response: Response): Promise<Response> {
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response;
}

export async function fetchProviders(): Promise<{
  types: ProviderType[];
  providers: Provider[];
}> {
  const body = (await (await ok(await fetch("/api/providers"))).json()) as Partial<{
    types: ProviderType[];
    providers: Provider[];
  }>;
  return { types: body.types ?? [], providers: body.providers ?? [] };
}

/** A save's answer; `loadError` is the app-server refusing what was stored. */
export interface SaveResult {
  provider: Provider;
  mod: ModState;
  loadError?: string;
}

export async function saveProvider(draft: ProviderDraft): Promise<SaveResult> {
  const response = await ok(
    await fetch("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    }),
  );
  return (await response.json()) as SaveResult;
}

export async function removeProvider(prefix: string): Promise<{ removed: boolean; mod: ModState }> {
  const response = await ok(
    await fetch(`/api/providers?prefix=${encodeURIComponent(prefix)}`, { method: "DELETE" }),
  );
  return (await response.json()) as { removed: boolean; mod: ModState };
}

/**
 * What an endpoint says it serves. The key goes in the body, never the URL, and
 * `prefix` lets the BFF use a stored key when the field was left blank — the
 * same fallback applies to the stored headers, joined by whatever rows the
 * form carries.
 */
export async function probeModels(input: {
  api: string;
  baseUrl: string;
  apiKey: string;
  type: string;
  prefix?: string;
  headers?: Record<string, string>;
}): Promise<ProbeResult> {
  const response = await ok(
    await fetch("/api/providers/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  const body = (await response.json()) as Partial<ProbeResult>;
  return { models: body.models ?? [], skipped: body.skipped ?? [] };
}

/** What a Test answered: the ids a provider can publish, and those it cannot. */
export interface ProbeResult {
  models: string[];
  skipped: string[];
}

/** The Test toast. A connection serves its own catalog, so its probe proves only the key. */
export function probeToast(found: ProbeResult, connection: boolean): string {
  if (connection) return "reachable — key accepted";
  const count = found.models.length;
  const head = `reachable — ${count} ${count === 1 ? "model" : "models"}`;
  return found.skipped.length > 0 ? `${head}, ${found.skipped.length} skipped` : head;
}
