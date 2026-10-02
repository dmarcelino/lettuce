import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import type { ServedModelInfo } from "./vision.ts";

/**
 * What this deployment is actually serving right now, learned from the one
 * permanent connection.
 *
 * The providers mod mirrors the served model list (a registration owns its
 * whole prefix), so the BFF has to keep a copy of it: which handles exist,
 * what window/max the auto-discovery published for each (`updateArgs`),
 * which prefixes have live connections and at which base URL.
 *
 * Frames are observed passively — every `list_models_response` a browser
 * triggers, every `list_connect_providers_response`, the whole stream — plus
 * the BFF's own forced refreshes (on connect, before a providers render,
 * and whenever a relayed connect/disconnect response says the model list
 * may have changed). That is what makes "the endpoint added a model" get
 * picked up: the next list any client triggers updates the mirror, and a
 * changed mirror re-renders the mod.
 */

export interface ProviderSightDeps {
  request(
    command: Record<string, unknown> & { type: string; request_id: string },
  ): Promise<unknown>;
  newRequestId(): string;
  log?: (message: string) => void;
}

export interface ObserveResult {
  /** The served set changed, so a rendered mod may be stale. */
  modelsChanged: boolean;
  /** A relayed connect/disconnect says the upstream model list may have changed. */
  modelsMayHaveChanged: boolean;
}

interface ModelsResponse {
  type: string;
  success?: boolean;
  entries?: unknown;
  available_handles?: unknown;
  byok_provider_aliases?: unknown;
}

function handlePrefix(handle: string): string {
  const cut = handle.indexOf("/");
  return cut > 0 ? handle.slice(0, cut) : "";
}

/** Fold one `list_models_response` into prefix → served models. */
function servedFrom(response: ModelsResponse): Map<string, ServedModelInfo[]> | null {
  const handles = response.available_handles;
  if (!Array.isArray(handles)) return null; // lookup failed or old server: trust nothing
  const entries = new Map<string, { label?: string; contextWindow?: number; maxTokens?: number }>();
  if (Array.isArray(response.entries)) {
    for (const raw of response.entries) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const handle = typeof entry.handle === "string" ? entry.handle : entry.id;
      if (typeof handle !== "string" || !handle) continue;
      const update = (entry.updateArgs ?? {}) as Record<string, unknown>;
      entries.set(handle, {
        label: typeof entry.label === "string" ? entry.label : undefined,
        contextWindow:
          typeof update.context_window === "number" ? update.context_window : undefined,
        maxTokens:
          typeof update.max_output_tokens === "number" ? update.max_output_tokens : undefined,
      });
    }
  }
  const byPrefix = new Map<string, ServedModelInfo[]>();
  for (const handle of handles) {
    if (typeof handle !== "string") continue;
    const prefix = handlePrefix(handle);
    if (!prefix) continue;
    const model = handle.slice(prefix.length + 1);
    if (!model) continue;
    const info = entries.get(handle) ?? {};
    const list = byPrefix.get(prefix) ?? [];
    if (!list.some((m) => m.id === model)) {
      list.push({
        id: model,
        ...(info.label ? { label: info.label } : {}),
        ...(info.contextWindow !== undefined ? { contextWindow: info.contextWindow } : {}),
        ...(info.maxTokens !== undefined ? { maxTokens: info.maxTokens } : {}),
      });
    }
    byPrefix.set(prefix, list);
  }
  return byPrefix;
}

function signatureOf(models: readonly ServedModelInfo[]): string {
  return models
    .map((m) => `${m.id}:${m.contextWindow ?? ""}:${m.maxTokens ?? ""}`)
    .sort()
    .join(",");
}

export class ProviderSight {
  private served = new Map<string, readonly ServedModelInfo[]>();
  private bases = new Map<string, string>();
  private connected = new Set<string>();
  /** Set once a list_models response has been applied since the last reset. */
  private loaded = false;
  private inflight: Promise<void> | null = null;
  /** alias → base from `byok_provider_aliases`; lets an `lc-…` prefix borrow its base's connection. */
  private aliases = new Map<string, string>();

  constructor(private readonly deps: ProviderSightDeps) {}

  /** Everything forgotten; the next refresh rebuilds from scratch. */
  reset(): void {
    this.loaded = false;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  servedModels(prefix: string): readonly ServedModelInfo[] | undefined {
    return this.served.get(prefix);
  }

  servedSnapshot(): ReadonlyMap<string, readonly ServedModelInfo[]> {
    return this.served;
  }

  baseUrlFor(prefix: string): string | undefined {
    const direct = this.bases.get(prefix);
    if (direct) return direct;
    const base = this.aliases.get(prefix);
    return base ? this.bases.get(base) : undefined;
  }

  isConnected(prefix: string): boolean {
    if (this.connected.has(prefix)) return true;
    const base = this.aliases.get(prefix);
    return base !== undefined && this.connected.has(base);
  }

  connectedPrefixes(): ReadonlySet<string> {
    return this.connected;
  }

  observe(frame: WsProtocolMessage): ObserveResult {
    const type = (frame as { type?: unknown }).type;
    if (type === "list_models_response") {
      return {
        modelsChanged: this.applyModels(frame as ModelsResponse),
        modelsMayHaveChanged: false,
      };
    }
    if (type === "list_connect_providers_response") {
      this.applyConnections(frame as { providers?: unknown });
      return { modelsChanged: false, modelsMayHaveChanged: false };
    }
    if (type === "connect_provider_response" || type === "disconnect_provider_response") {
      // Only a response to a request this process made on a session's behalf
      // carries meaning here, and every such relayed response counts.
      const changed = (frame as { models_may_have_changed?: unknown }).models_may_have_changed;
      return { modelsChanged: false, modelsMayHaveChanged: changed !== false };
    }
    return { modelsChanged: false, modelsMayHaveChanged: false };
  }

  applyModels(response: ModelsResponse): boolean {
    if (response.success === false) return false;
    if (response.byok_provider_aliases && typeof response.byok_provider_aliases === "object") {
      this.aliases = new Map(
        Object.entries(response.byok_provider_aliases as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    }
    const next = servedFrom(response);
    if (!next) return false;
    this.loaded = true;
    const changed =
      next.size !== this.served.size ||
      [...next].some(([prefix, models]) => {
        const previous = this.served.get(prefix);
        return !previous || signatureOf(previous) !== signatureOf(models);
      });
    this.served = next;
    return changed;
  }

  applyConnections(response: { providers?: unknown }): void {
    if (!Array.isArray(response.providers)) return;
    for (const raw of response.providers) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const names = [
        ...(Array.isArray(row.provider_names)
          ? row.provider_names.filter((n): n is string => typeof n === "string")
          : []),
        ...(typeof row.provider_name === "string" ? [row.provider_name] : []),
      ];
      const state = row.connected;
      const live =
        typeof state === "object" &&
        state !== null &&
        (state as { is_connected?: unknown }).is_connected === true;
      const baseUrl =
        typeof state === "object" && state !== null
          ? (state as { base_url?: unknown }).base_url
          : undefined;
      for (const name of names) {
        if (live) {
          this.connected.add(name);
          if (typeof baseUrl === "string" && baseUrl) this.bases.set(name, baseUrl);
        } else {
          this.connected.delete(name);
          this.bases.delete(name);
        }
      }
    }
  }

  /**
   * Force both lists through the permanent connection. Concurrent calls share
   * one round trip; failures are the caller's problem (a providers render that
   * gets a throw keeps the previous mod file).
   */
  refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          const models = (await this.deps.request({
            type: "list_models",
            request_id: this.deps.newRequestId(),
            force: true,
          })) as ModelsResponse;
          this.applyModels(models);
          const providers = (await this.deps.request({
            type: "list_connect_providers",
            request_id: this.deps.newRequestId(),
            target: "local",
          })) as { providers?: unknown };
          this.applyConnections(providers);
        } finally {
          this.inflight = null;
        }
      })();
    }
    return this.inflight;
  }
}
