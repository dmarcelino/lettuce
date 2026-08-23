import { useCallback, useEffect, useRef, useState } from "react";
import { handleProvider } from "../lib/providers.ts";
import type { SessionApi } from "./use-session.ts";

export interface ModelEntry {
  id: string;
  handle: string;
  label: string;
  description: string;
}

/**
 * How much the server could tell us about what is actually served.
 *
 * `list_models` always returns the whole bundled preset catalog (Sonnet, Opus,
 * GPT…) alongside the models the configured backend really serves. Only
 * `available_handles` separates the two, and it has three distinct states —
 * mirrored from the fork's own selector (`model-selector-helpers.ts`) and
 * channel executor (`command-runtime-executor.ts`).
 */
export type Availability =
  /** `available_handles` was a list: the entries below are exactly what is served. */
  | "filtered"
  /** `null` — the backend lookup failed. Showing the unfiltered built-in list. */
  | "lookup-failed"
  /** absent — server too old to report availability. Showing the built-in list. */
  | "not-reported";

/**
 * Two consecutive refreshes disagreed about what is served.
 *
 * The signal that matters when an endpoint load-balances its `/models` route:
 * each call is answered by a different backend, so the list silently changes
 * under you. Counts alone are not enough — two different backends can serve the
 * same number of models — so the comparison is on the handle set.
 */
export interface ModelSetChange {
  previousCount: number;
  currentCount: number;
}

export interface ModelsApi {
  models: ModelEntry[];
  availability: Availability;
  loading: boolean;
  error: string | null;
  /** Distinct provider segments across the served handles, e.g. ["llama.cpp"]. */
  providers: string[];
  /** Set when the last refresh returned a different set than the one before it. */
  changed: ModelSetChange | null;
  /** User-initiated refetch; bypasses the listener's availability cache. */
  refresh: () => Promise<void>;
}

/** Order-insensitive comparison: a reordered list is not a changed list. */
export function sameHandleSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((handle) => seen.has(handle));
}

interface ListModelsResponse {
  entries?: unknown[];
  available_handles?: unknown;
  error?: string;
}

function readEntry(raw: unknown): ModelEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const model = raw as {
    id?: unknown;
    handle?: unknown;
    label?: unknown;
    description?: unknown;
  };
  if (typeof model.id !== "string") return null;
  const handle = typeof model.handle === "string" ? model.handle : model.id;
  return {
    id: model.id,
    handle,
    label: typeof model.label === "string" ? model.label : model.id,
    description: typeof model.description === "string" ? model.description : "",
  };
}

/**
 * Keep only the handles the backend reports as served, in the order it gave
 * them. A handle with no catalog entry still gets listed — availability is
 * authoritative, the curated catalog is only presentation.
 */
function filterToAvailable(entries: ModelEntry[], handles: string[]): ModelEntry[] {
  const byHandle = new Map(entries.map((entry) => [entry.handle, entry]));
  const seen = new Set<string>();
  return handles.flatMap((handle) => {
    if (seen.has(handle)) return [];
    seen.add(handle);
    const entry = byHandle.get(handle);
    return [entry ?? { id: handle, handle, label: handle, description: "" }];
  });
}

export function useModels(session: SessionApi): ModelsApi {
  const { request, ready } = session;
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [availability, setAvailability] = useState<Availability>("filtered");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState<ModelSetChange | null>(null);
  /** The handle set from the previous successful load, for comparison. */
  const previousHandles = useRef<string[] | null>(null);

  const load = useCallback(
    async (force: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const response = await request<ListModelsResponse>(
          "list_models",
          force ? { force: true } : {},
        );
        const entries = Array.isArray(response?.entries)
          ? response.entries.flatMap((raw) => {
              const entry = readEntry(raw);
              return entry ? [entry] : [];
            })
          : [];

        const handles = response?.available_handles;

        // Compare against the previous load before anything else consumes it:
        // a set that changes between refreshes means the endpoint is answering
        // from a different backend each time.
        if (Array.isArray(handles)) {
          const current = handles.filter((h): h is string => typeof h === "string");
          const previous = previousHandles.current;
          setChanged(
            previous && !sameHandleSet(previous, current)
              ? { previousCount: previous.length, currentCount: current.length }
              : null,
          );
          previousHandles.current = current;
        }

        if (Array.isArray(handles)) {
          setModels(
            filterToAvailable(
              entries,
              handles.filter((h): h is string => typeof h === "string"),
            ),
          );
          setAvailability("filtered");
        } else {
          setModels(entries);
          setAvailability(handles === null ? "lookup-failed" : "not-reported");
        }
        if (response?.error) setError(response.error);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [request],
  );

  useEffect(() => {
    if (ready) void load(false);
  }, [ready, load]);

  const refresh = useCallback(() => load(true), [load]);

  const providers = [...new Set(models.map((m) => handleProvider(m.handle)).filter(Boolean))];

  return { models, availability, loading, error, providers, changed, refresh };
}

/**
 * The model in force for a scope, for showing which entry is active.
 *
 * Client-side twin of the app-server's `getCurrentModelScopeSnapshot`: a
 * conversation's own model wins, otherwise the agent's. `"default"` is the
 * virtual conversation id meaning "the agent itself", so it skips straight to
 * the agent.
 */
export function useCurrentModel(
  session: SessionApi,
  agentId: string | null,
  conversationId: string | null,
): { handle: string | null; setHandle: (handle: string | null) => void } {
  const { request, ready } = session;
  const [handle, setHandle] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !agentId) return;
    let cancelled = false;

    void (async () => {
      try {
        if (conversationId && conversationId !== "default") {
          const response = await request<{ conversation?: { model?: unknown } | null }>(
            "conversation_retrieve",
            { conversation_id: conversationId },
          );
          const model = response?.conversation?.model;
          if (typeof model === "string" && model) {
            if (!cancelled) setHandle(model);
            return;
          }
        }

        const response = await request<{ agent?: Record<string, unknown> | null }>(
          "agent_retrieve",
          { agent_id: agentId },
        );
        if (cancelled) return;
        setHandle(readAgentModelHandle(response?.agent ?? null));
      } catch {
        // Non-fatal: the picker simply shows no active entry.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, agentId, conversationId, request]);

  return { handle, setHandle };
}

/** `agent.model`, falling back to reassembling it from the LLM config. */
export function readAgentModelHandle(agent: Record<string, unknown> | null): string | null {
  if (!agent) return null;
  if (typeof agent.model === "string" && agent.model) return agent.model;
  const config = agent.llm_config as { model?: unknown; model_endpoint_type?: unknown } | undefined;
  if (!config) return null;
  if (typeof config.model_endpoint_type === "string" && typeof config.model === "string") {
    return `${config.model_endpoint_type}/${config.model}`;
  }
  return typeof config.model === "string" ? config.model : null;
}
