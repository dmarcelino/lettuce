/**
 * Settings → Codex: what Codex subagent workers run against.
 *
 * letta-code starts `codex` (our shim, docker/codex) for `subagent_type:
 * "codex"` and hands it nothing but a prompt and a cwd, so everything else —
 * endpoint, model, key — has to be in Codex's own `$CODEX_HOME/config.toml`.
 * The BFF owns that file: it keeps the settings the user saved as
 * `lettuce.json` and renders `config.toml` and `auth.json` from them, all over
 * the permanent upstream connection (`write_file`), never a bind mount.
 *
 * `lettuce.json` doubles as the shim's switch: absent, unreadable or
 * `enabled: false` and the shim refuses to run (docker/codex/shim-core.mjs).
 */

/** On the letta-home bind mount (`CODEX_HOME` in docker/compose.yml). */
export const CODEX_HOME = "/root/.letta/codex";
export const CODEX_SETTINGS_PATH = `${CODEX_HOME}/lettuce.json`;
/**
 * This file's name before the `letta-ui` → `lettuce` rename. The BFF reads it
 * when the new one is absent and mirrors every write into it, because the
 * `codex` shim that reads it ships in the app-server image — and that image is
 * only rebuilt on a version bump, so a new BFF runs against an old shim for a
 * while. Drop both halves once the pinned image postdates the rename.
 */
export const CODEX_SETTINGS_LEGACY_PATH = `${CODEX_HOME}/letta-ui.json`;
export const CODEX_CONFIG_PATH = `${CODEX_HOME}/config.toml`;
export const CODEX_AUTH_PATH = `${CODEX_HOME}/auth.json`;
/** letta-code's own provider record — the source of the suggested endpoint. */
export const LETTA_PROVIDERS_PATH = "/data/local-backend/providers/auth.json";

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface CodexSettings {
  enabled: boolean;
  /** OpenAI-compatible base URL serving the Responses API, e.g. `http://host:8080/v1`. */
  baseUrl: string;
  model: string;
  /** Bearer token for `baseUrl`. Never sent back to a browser. */
  apiKey: string | null;
  reasoningEffort: ReasoningEffort | null;
  contextWindow: number | null;
  /** Codex's `stream_idle_timeout_ms`; its default is 5 minutes. */
  streamIdleTimeoutSeconds: number | null;
}

/** What the browser sees: the key is reduced to whether one is set. */
export type PublicCodexSettings = Omit<CodexSettings, "apiKey"> & { hasApiKey: boolean };

export const DEFAULT_CODEX_SETTINGS: CodexSettings = {
  enabled: false,
  baseUrl: "",
  model: "",
  apiKey: null,
  reasoningEffort: null,
  contextWindow: null,
  streamIdleTimeoutSeconds: null,
};

export class InvalidCodexSettingsError extends Error {}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function effortOf(value: unknown): ReasoningEffort | null {
  return REASONING_EFFORTS.includes(value as ReasoningEffort) ? (value as ReasoningEffort) : null;
}

/** Lenient: a hand-edited or older file still loads, with defaults filling the gaps. */
export function parseStoredCodexSettings(text: string | null): CodexSettings {
  if (!text) return { ...DEFAULT_CODEX_SETTINGS };
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CODEX_SETTINGS };
    raw = parsed as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_CODEX_SETTINGS };
  }
  return {
    enabled: raw.enabled === true,
    baseUrl: optionalString(raw.baseUrl) ?? "",
    model: optionalString(raw.model) ?? "",
    apiKey: optionalString(raw.apiKey),
    reasoningEffort: effortOf(raw.reasoningEffort),
    contextWindow: optionalPositiveInt(raw.contextWindow),
    streamIdleTimeoutSeconds: optionalPositiveInt(raw.streamIdleTimeoutSeconds),
  };
}

function nullableInt(body: Record<string, unknown>, key: string, current: number | null) {
  if (!(key in body)) return current;
  const value = body[key];
  if (value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new InvalidCodexSettingsError(`${key} must be a positive whole number`);
  }
  return value;
}

function bool(body: Record<string, unknown>, key: string, current: boolean): boolean {
  if (!(key in body)) return current;
  if (typeof body[key] !== "boolean")
    throw new InvalidCodexSettingsError(`${key} must be true or false`);
  return body[key] as boolean;
}

/**
 * Apply a browser update onto the stored settings. Absent fields keep their
 * value; `apiKey` in particular is write-only, so leaving it out keeps the
 * saved key and `null` / `""` clears it.
 */
export function applyCodexSettingsUpdate(current: CodexSettings, body: unknown): CodexSettings {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new InvalidCodexSettingsError("Expected a JSON object");
  }
  const input = body as Record<string, unknown>;
  const next: CodexSettings = {
    ...current,
    enabled: bool(input, "enabled", current.enabled),
    contextWindow: nullableInt(input, "contextWindow", current.contextWindow),
    streamIdleTimeoutSeconds: nullableInt(
      input,
      "streamIdleTimeoutSeconds",
      current.streamIdleTimeoutSeconds,
    ),
  };

  if ("baseUrl" in input) {
    const url = typeof input.baseUrl === "string" ? input.baseUrl.trim().replace(/\/+$/, "") : "";
    if (url && !/^https?:\/\/[^\s/]+/.test(url)) {
      throw new InvalidCodexSettingsError("baseUrl must be an http(s) URL");
    }
    next.baseUrl = url;
  }
  if ("model" in input) {
    if (input.model !== null && typeof input.model !== "string") {
      throw new InvalidCodexSettingsError("model must be text");
    }
    next.model = typeof input.model === "string" ? input.model.trim() : "";
  }
  if ("apiKey" in input) {
    if (input.apiKey !== null && typeof input.apiKey !== "string") {
      throw new InvalidCodexSettingsError("apiKey must be text");
    }
    next.apiKey = optionalString(input.apiKey);
  }
  if ("reasoningEffort" in input) {
    if (input.reasoningEffort === null || input.reasoningEffort === "") {
      next.reasoningEffort = null;
    } else {
      const effort = effortOf(input.reasoningEffort);
      if (!effort) {
        throw new InvalidCodexSettingsError(
          `reasoningEffort must be one of ${REASONING_EFFORTS.join(", ")}`,
        );
      }
      next.reasoningEffort = effort;
    }
  }

  if (next.enabled && (!next.baseUrl || !next.model)) {
    throw new InvalidCodexSettingsError(
      "Set an endpoint URL and a model before enabling Codex workers",
    );
  }
  return next;
}

export function toPublicCodexSettings(settings: CodexSettings): PublicCodexSettings {
  const { apiKey, ...rest } = settings;
  return { ...rest, hasApiKey: apiKey !== null };
}

/** JSON's string escapes are all valid in a TOML basic string. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Codex's own config. Regenerated on every save and every upstream connect. */
export function renderCodexConfigToml(settings: CodexSettings): string {
  const lines = [
    "# Written by lettuce (Settings → Codex). Edits here are overwritten.",
    `model = ${tomlString(settings.model)}`,
    `model_provider = "lettuce"`,
  ];
  if (settings.reasoningEffort) {
    lines.push(`model_reasoning_effort = ${tomlString(settings.reasoningEffort)}`);
  }
  if (settings.contextWindow) lines.push(`model_context_window = ${settings.contextWindow}`);
  lines.push(
    "",
    "[model_providers.lettuce]",
    `name = "lettuce"`,
    `base_url = ${tomlString(settings.baseUrl)}`,
    `wire_api = "responses"`,
  );
  if (settings.apiKey) lines.push(`experimental_bearer_token = ${tomlString(settings.apiKey)}`);
  if (settings.streamIdleTimeoutSeconds) {
    lines.push(`stream_idle_timeout_ms = ${settings.streamIdleTimeoutSeconds * 1000}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * letta-code before 0.33.3 preflighted a Codex worker with `codex login status`,
 * which exits non-zero until *some* login exists; this placeholder satisfied it.
 * Since 0.33.3 the preflight is `codex --version`, so it is vestigial but
 * harmless. It is an OpenAI-provider credential, and no
 * worker uses that provider: `lettuce` above authenticates with its own
 * `experimental_bearer_token`, or not at all.
 */
export const CODEX_PLACEHOLDER_KEY = "lettuce-placeholder-not-an-openai-key";

export function renderCodexAuthJson(): string {
  return `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: CODEX_PLACEHOLDER_KEY }, null, 2)}\n`;
}

/**
 * The stored settings. Also what the shim reads for `enabled`; it sits beside
 * `config.toml`, which carries the key anyway.
 */
export function renderStoredCodexSettings(settings: CodexSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * The endpoint letta-code itself uses, offered as the default: the stack's
 * one OpenAI-compatible provider (`letta connect`), when there is one.
 */
export function suggestCodexBaseUrl(providersJson: string | null): string | null {
  if (!providersJson) return null;
  try {
    const parsed = JSON.parse(providersJson) as {
      providers?: Record<string, { provider_type?: unknown; base_url?: unknown }>;
    };
    for (const provider of Object.values(parsed.providers ?? {})) {
      if (provider.provider_type === "openai-compatible" && typeof provider.base_url === "string") {
        return provider.base_url.replace(/\/+$/, "");
      }
    }
  } catch {
    // Unreadable provider file: no suggestion.
  }
  return null;
}
