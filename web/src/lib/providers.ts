/**
 * Telling a locally-served model from a cloud one, client-side.
 *
 * The obvious approach — compare the handle's provider segment against the
 * provider's own `provider_name` — is wrong for exactly one provider, and it is
 * the one this deployment uses. llama.cpp reports
 * `provider_names: ["llama-cpp", "lc-llama-cpp"]` (hyphen), but every handle it
 * serves is stamped `llama.cpp/…` (dot), because upstream's
 * `handlePrefixes[0]` is the dotted spelling. A literal comparison misses every
 * model, which is how "Models served" ended up empty with everything filed
 * under Cloud.
 *
 * `ConnectProviderEntry` carries no `handle_prefixes`, so the dotted spelling
 * cannot be learned from the protocol. Two defences instead: normalise both
 * sides so separators stop mattering, and mirror upstream's own local-prefix
 * list as a fallback for handles that match no connected row.
 */

/**
 * Fold a provider key to something comparable: lowercase, separators removed,
 * and the `lc-` BYOK alias marker stripped.
 *
 * llama.cpp -> llamacpp ; llama-cpp -> llamacpp ; lc-llama-cpp -> llamacpp
 */
export function normalizeProviderKey(value: string): string {
  const lower = value.toLowerCase();
  const withoutAlias = lower.startsWith("lc-") ? lower.slice(3) : lower;
  return withoutAlias.replace(/[.\-_]/g, "");
}

/**
 * Mirrors `LOCAL_MODEL_HANDLE_PREFIXES` in
 * letta-code/src/agent/model-handles.ts. Kept in sync by hand because the
 * protocol does not expose it; `scripts/sync-upstream.sh` reports drift in that
 * file's directory.
 *
 * Note `ollama-cloud` is in upstream's list too: it means "served over a
 * local-style OpenAI-compatible endpoint", not "runs on this machine".
 */
const LOCAL_HANDLE_PREFIXES = [
  "ollama",
  "ollama-cloud",
  "lmstudio",
  "llama.cpp",
  "llama-cpp",
  "openai-compatible",
].map(normalizeProviderKey);

/** The provider segment of a handle, e.g. "llama.cpp/Gemma-4" -> "llama.cpp". */
export function handleProvider(handle: string): string {
  return handle.split("/")[0] ?? "";
}

export interface ProviderNames {
  provider_name?: string;
  provider_names?: string[];
}

/** Normalised keys for every alias the given provider rows answer to. */
export function localProviderKeys(providers: readonly ProviderNames[]): Set<string> {
  const keys = new Set<string>();
  for (const provider of providers) {
    for (const name of [provider.provider_name, ...(provider.provider_names ?? [])]) {
      if (name) keys.add(normalizeProviderKey(name));
    }
  }
  return keys;
}

/**
 * Is this handle served by one of the connected local endpoints?
 *
 * Falls back to the mirrored prefix list so a served model is still classified
 * correctly when its provider row is absent from the list response.
 */
export function isLocalHandle(handle: string, localKeys: ReadonlySet<string>): boolean {
  const key = normalizeProviderKey(handleProvider(handle));
  if (!key) return false;
  return localKeys.has(key) || LOCAL_HANDLE_PREFIXES.includes(key);
}
