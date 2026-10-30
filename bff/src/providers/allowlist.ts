/**
 * The models an operator left unticked on a connection the app-server holds itself
 * (`ProviderType.connection`: OpenRouter and the other hosts naming models
 * `vendor/model`). Upstream serves such a connection's whole catalog and has no
 * per-connection filter, so the BFF drops them from the model list on its way to
 * the browsers — after `ProviderSight` has seen it whole, which the providers
 * render and the conflict checks rely on. Only what was unticked is dropped, so a
 * model a letta-code upgrade adds shows up on its own.
 *
 * Presentation only: an agent already set to a model left out keeps working.
 */

import type { WsProtocolMessage } from "@letta-ai/letta-code/app-server-protocol";
import { handlePrefix } from "./sight.ts";

/**
 * A `list_models_response` without each connection's hidden models, or the same
 * frame object when nothing applies. Never mutates its input.
 */
export function filterServedModels(
  frame: WsProtocolMessage,
  hidden: ReadonlyMap<string, ReadonlySet<string>>,
): WsProtocolMessage {
  if ((frame as { type?: unknown }).type !== "list_models_response") return frame;
  if (hidden.size === 0) return frame;
  const response = frame as unknown as { entries?: unknown; available_handles?: unknown };
  if (!Array.isArray(response.available_handles)) return frame;

  const keep = (handle: unknown): boolean => {
    if (typeof handle !== "string") return true;
    const prefix = handlePrefix(handle);
    return !hidden.get(prefix)?.has(handle.slice(prefix.length + 1));
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
