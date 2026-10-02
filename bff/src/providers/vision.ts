/**
 * Vision-capable model providers declared by configuration.
 *
 * letta-code detects model capabilities from each provider's own native
 * schema — llama.cpp's `architecture.input_modalities` / `/props`
 * `modalities.vision`, Ollama's `/api/tags` capabilities — and resolves
 * every model behind a plain OpenAI-compatible `/v1/models` endpoint as
 * text-only on purpose (that schema carries no capabilities, and letta
 * never guesses from the model name). pi-ai then replaces image content
 * parts with the text "(image omitted: model does not support images)"
 * before the model call, so the agent reports not seeing the image even
 * though the server accepts images perfectly well.
 *
 * Upstream's sanctioned override is a provider mod (`letta.providers.register`,
 * letta-code's `creating-mods` skill reference): a mod's model declaration
 * IS the capability truth — the `input` list, the real context window, all
 * of it. The auto-discovered path also clamps the window to the harness
 * default (128 000), so the mod is how a 256k server actually gets its real
 * window published. The BFF renders it from the `VISION_PROVIDERS` env
 * (JSON array, see docs/CONFIGURATION.md) and keeps it on disk like every
 * other mod, so the app-server reloads it the same way.
 */

import { MODS_DIR } from "../internal-tools/mod.ts";

export const PROVIDERS_MOD_PATH = `${MODS_DIR}/letta-ui-providers.mjs`;

/** The id shapes upstream's own provider-mod validation enforces. */
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

export interface VisionModelConfig {
  id: string;
  name?: string;
  /** Default false — mirrors what the auto-discovered model reports. */
  reasoning?: boolean;
  /** Default `["text","image"]`: declaring a vision provider means vision. */
  input?: readonly ("text" | "image")[];
  /** Tokens. The real served window — the whole point of the mod. */
  contextWindow: number;
  /** Completion budget cap in tokens (the endpoint's own cap, not a guess). */
  maxTokens: number;
}

export interface VisionProviderConfig {
  /** Stable lowercase provider id; model handles become `<id>/<model>`. */
  id: string;
  name?: string;
  description?: string;
  /** OpenAI-compatible base URL, `/v1` included (or the proxy's path to it). */
  baseUrl: string;
  /** Env-var name resolved at mod load, or a literal; default "not-needed". */
  apiKey?: string;
  models: readonly VisionModelConfig[];
}

/** Thrown for a malformed VISION_PROVIDERS; the message is log-facing. */
export class VisionProvidersError extends Error {}

function fail(message: string): never {
  throw new VisionProvidersError(`VISION_PROVIDERS: ${message}`);
}

function positiveInt(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`${what} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Parse the VISION_PROVIDERS JSON. An unset or empty value means no extra
 * providers — not an error. Anything malformed throws with the offender
 * named, because a silent drop here would look like "mod missing" forever.
 */
export function parseVisionProviders(raw: string | undefined | null): VisionProviderConfig[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!Array.isArray(parsed)) fail("must be a JSON array");

  const seen = new Set<string>();
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object") fail("every entry must be an object");
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || !PROVIDER_ID_RE.test(id)) {
      fail(`provider id ${JSON.stringify(id)} must match ${PROVIDER_ID_RE}`);
    }
    if (seen.has(id)) fail(`provider id "${id}" appears twice`);
    seen.add(id);
    const baseUrl = record.baseUrl;
    if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) {
      fail(`provider "${id}" needs an http(s) baseUrl`);
    }
    if (!Array.isArray(record.models) || record.models.length === 0) {
      fail(`provider "${id}" needs a non-empty models array`);
    }
    const models = record.models.map((modelEntry, index) => {
      const model = (modelEntry ?? {}) as Record<string, unknown>;
      const modelId = model.id;
      if (
        typeof modelId !== "string" ||
        modelId.length === 0 ||
        modelId.includes("/") ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(modelId)
      ) {
        fail(`provider "${id}" model ${index} has an invalid id ${JSON.stringify(modelId)}`);
      }
      const input =
        model.input === undefined
          ? (["text", "image"] as const)
          : (() => {
              if (
                !Array.isArray(model.input) ||
                model.input.length === 0 ||
                !model.input.every((m) => m === "text" || m === "image")
              ) {
                fail(`provider "${id}" model "${modelId}" input must be ["text","image"]`);
              }
              return model.input as ("text" | "image")[];
            })();
      return {
        id: modelId,
        ...(typeof model.name === "string" && model.name ? { name: model.name } : {}),
        ...(model.reasoning === true ? { reasoning: true } : {}),
        input,
        contextWindow: positiveInt(
          model.contextWindow,
          `provider "${id}" model "${modelId}" contextWindow`,
        ),
        maxTokens: positiveInt(model.maxTokens, `provider "${id}" model "${modelId}" maxTokens`),
      } satisfies VisionModelConfig;
    });
    return {
      id,
      ...(typeof record.name === "string" && record.name ? { name: record.name } : {}),
      ...(typeof record.description === "string" && record.description
        ? { description: record.description }
        : {}),
      baseUrl,
      ...(typeof record.apiKey === "string" && record.apiKey ? { apiKey: record.apiKey } : {}),
      models,
    } satisfies VisionProviderConfig;
  });
}

/**
 * The provider mod: one `letta.providers.register` per configured provider.
 * Empty config renders a mod that registers nothing, because the reload
 * protocol cannot delete a file and a stale provider must be able to go away.
 */
export function renderProvidersMod(providers: readonly VisionProviderConfig[]): string {
  const header = `// letta-ui providers v1 — rendered by the lettuce BFF (bff/src/providers/vision.ts).
// Edits here are overwritten on the BFF's next connect; change VISION_PROVIDERS instead.`;
  if (providers.length === 0) {
    return `${header}
// No vision providers configured: registers nothing.
export default function activate() {}
`;
  }
  const registrations = providers
    .map((provider) => {
      const registration = {
        name: provider.name ?? provider.id,
        ...(provider.description ? { description: provider.description } : {}),
        api: "openai-completions",
        baseUrl: provider.baseUrl,
        // Resolved as process.env[apiKey] ?? apiKey by letta-code's mod
        // validation, so "not-needed" (the default) sends no Authorization.
        apiKey: provider.apiKey ?? "not-needed",
        // No /connect step: the key (if any) and the URL are already declared.
        connect: false,
        models: provider.models.map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          reasoning: model.reasoning === true,
          input: [...(model.input ?? ["text", "image"])],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        })),
      };
      return `  letta.providers.register(${JSON.stringify(provider.id)}, ${JSON.stringify(
        registration,
        null,
        4,
      )
        .split("\n")
        .join("\n  ")});`;
    })
    .join("\n\n");
  return `${header}
export default function activate(letta) {
  if (!letta.capabilities?.providers) return;

${registrations}
}
`;
}
