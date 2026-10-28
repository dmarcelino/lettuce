/**
 * The models an operator picked from a connection the app-server holds itself
 * (`ProviderType.connection`: OpenRouter and the other hosts naming models
 * `vendor/model`). Upstream serves such a connection's whole catalog and has no
 * per-connection filter, so the BFF trims the model list on its way to the
 * browsers — after `ProviderSight` has seen it whole, which the providers render
 * and the conflict checks rely on.
 *
 * Presentation only: an agent already set to a model left out keeps working.
 */

import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";

function prefixOf(handle: string): string {
  const cut = handle.indexOf("/");
  return cut > 0 ? handle.slice(0, cut) : "";
}

/**
 * A `list_models_response` with each allowlisted prefix trimmed to its picks, or
 * the same frame object when nothing applies. Never mutates its input.
 */
export function filterServedModels(
  frame: WsProtocolMessage,
  allowlists: Readonly<Record<string, readonly string[]>>,
): WsProtocolMessage {
  if ((frame as { type?: unknown }).type !== "list_models_response") return frame;
  if (Object.keys(allowlists).length === 0) return frame;
  const response = frame as unknown as { entries?: unknown; available_handles?: unknown };
  if (!Array.isArray(response.available_handles)) return frame;

  const allowed = new Map(
    Object.entries(allowlists).map(([prefix, ids]) => [prefix, new Set(ids)]),
  );
  const keep = (handle: unknown): boolean => {
    if (typeof handle !== "string") return true;
    const prefix = prefixOf(handle);
    const picks = allowed.get(prefix);
    return !picks || picks.has(handle.slice(prefix.length + 1));
  };
  return {
    ...(frame as object),
    available_handles: response.available_handles.filter(keep),
    ...(Array.isArray(response.entries)
      ? {
          entries: response.entries.filter((raw) => {
            const entry = (raw ?? {}) as { handle?: unknown; id?: unknown };
            return keep(typeof entry.handle === "string" ? entry.handle : entry.id);
          }),
        }
      : {}),
  } as unknown as WsProtocolMessage;
}
