import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PROVIDER_ID_RE, type VisionProviderConfig } from "./vision.ts";

/**
 * What the operator has declared about models the server cannot describe.
 *
 * A plain OpenAI-compatible endpoint reports no capabilities, so letta-code
 * resolves every model behind one as text-only at the harness default window.
 * The declarations here — vision, thinking, the real context window — are what
 * the BFF renders into the providers mod, which is THE capability truth for
 * every prefix it registers (see `vision.ts` and the spike notes).
 *
 * Stored on the `bff-data` volume like the other small operator settings.
 * Keys stored here are write-only from the BFF's side: the protocol never
 * echoes a connection key back, and neither does any route here.
 */

export interface ModelCaps {
  vision: boolean;
  thinking: boolean;
  /** Tokens. The real served window, published in place of the 128k clamp. */
  contextWindow: number;
  /** Completion budget cap in tokens (the endpoint's own cap, not a guess). */
  maxTokens: number;
}

/** Endpoint metadata the mod needs but the protocol cannot give back. */
export interface EndpointInfo {
  apiKey?: string;
  baseUrl?: string;
  name?: string;
}

/** Thrown for a malformed Settings payload; the message is shown to the user. */
export class ModelCapsError extends Error {}

/**
 * A model handle split into its parts, or null when malformed. The prefix is
 * lower-cased because a provider id must be (upstream validates it against
 * `PROVIDER_ID_RE`); the model segment keeps its case — served model ids are
 * case-sensitive (`Qwen3.8-Flash-Next`), and the only slash is the separator.
 */
export function splitHandle(handle: unknown): { prefix: string; model: string } | null {
  if (typeof handle !== "string") return null;
  const cut = handle.indexOf("/");
  if (cut <= 0 || cut === handle.length - 1) return null;
  const prefix = handle.slice(0, cut).toLowerCase();
  const model = handle.slice(cut + 1);
  if (!PROVIDER_ID_RE.test(prefix)) return null;
  if (model.includes("/") || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model)) return null;
  return { prefix, model };
}

function positiveInt(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ModelCapsError(`${what} must be a positive integer`);
  }
  return value;
}

function readCaps(entry: unknown): ModelCaps | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.vision !== "boolean" || typeof record.thinking !== "boolean") return null;
  const window = record.contextWindow;
  const max = record.maxTokens;
  if (
    typeof window !== "number" ||
    !Number.isInteger(window) ||
    window <= 0 ||
    typeof max !== "number" ||
    !Number.isInteger(max) ||
    max <= 0
  ) {
    return null;
  }
  return {
    vision: record.vision,
    thinking: record.thinking,
    contextWindow: window,
    maxTokens: max,
  };
}

/**
 * Parse a `PUT /api/model-caps` body. Returns the canonical handle and caps
 * (prefix lower-cased), or throws with the complaint the UI should show.
 */
export function parseModelCapsBody(body: unknown): {
  handle: string;
  caps: ModelCaps;
  apiKey: string | null;
} {
  if (!body || typeof body !== "object") throw new ModelCapsError("Body must be an object");
  const record = body as Record<string, unknown>;
  const parts = splitHandle(record.handle);
  if (!parts) {
    throw new ModelCapsError(
      `handle must look like "provider/model" with a lowercase provider prefix`,
    );
  }
  if (typeof record.vision !== "boolean" || typeof record.thinking !== "boolean") {
    throw new ModelCapsError("vision and thinking must be booleans");
  }
  const apiKey =
    typeof record.apiKey === "string" && record.apiKey.trim() !== "" ? record.apiKey.trim() : null;
  return {
    handle: `${parts.prefix}/${parts.model}`,
    caps: {
      vision: record.vision,
      thinking: record.thinking,
      contextWindow: positiveInt(record.contextWindow, "contextWindow"),
      maxTokens: positiveInt(record.maxTokens, "maxTokens"),
    },
    apiKey,
  };
}

function readEndpoint(entry: unknown): EndpointInfo | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const info: EndpointInfo = {};
  if (typeof record.apiKey === "string" && record.apiKey) info.apiKey = record.apiKey;
  if (typeof record.baseUrl === "string" && record.baseUrl) info.baseUrl = record.baseUrl;
  if (typeof record.name === "string" && record.name) info.name = record.name;
  return info;
}

export class ModelCapsStore {
  private modelEntries = new Map<string, ModelCaps>();
  private endpointEntries = new Map<string, EndpointInfo>();
  private writeQueue: Promise<void> = Promise.resolve();
  /** Whether the file existed when this store was constructed. */
  readonly seededFrom: "file" | "none";

  constructor(
    private readonly filePath: string,
    private readonly onWriteError: (error: unknown) => void,
  ) {
    this.seededFrom = existsSync(filePath) ? "file" : "none";
    if (this.seededFrom === "file") {
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
        const record = (parsed ?? {}) as Record<string, unknown>;
        const models = record.models;
        if (models && typeof models === "object" && !Array.isArray(models)) {
          for (const [handle, raw] of Object.entries(models)) {
            const parts = splitHandle(handle);
            const caps = readCaps(raw);
            if (parts && caps) this.modelEntries.set(`${parts.prefix}/${parts.model}`, caps);
          }
        }
        const endpoints = record.endpoints;
        if (endpoints && typeof endpoints === "object" && !Array.isArray(endpoints)) {
          for (const [prefix, raw] of Object.entries(endpoints)) {
            const info = readEndpoint(raw);
            if (PROVIDER_ID_RE.test(prefix) && info) this.endpointEntries.set(prefix, info);
          }
        }
      } catch {
        // Unreadable: behave like an empty store rather than failing to boot;
        // the next save rewrites the file whole.
      }
    }
  }

  models(): Record<string, ModelCaps> {
    return Object.fromEntries(this.modelEntries);
  }

  /** The provider prefixes that carry at least one declared model. */
  declaredPrefixes(): Set<string> {
    const prefixes = new Set<string>();
    for (const handle of this.modelEntries.keys()) {
      const cut = handle.indexOf("/");
      if (cut > 0) prefixes.add(handle.slice(0, cut));
    }
    return prefixes;
  }

  endpoints(): Record<string, EndpointInfo> {
    return Object.fromEntries(this.endpointEntries);
  }

  endpoint(prefix: string): EndpointInfo | undefined {
    return this.endpointEntries.get(prefix);
  }

  /** Merges into any stored group; only defined values overwrite. Blank never clears. */
  setEndpoint(prefix: string, patch: { apiKey?: string; baseUrl?: string; name?: string }): void {
    const current = this.endpointEntries.get(prefix) ?? {};
    this.endpointEntries.set(prefix, {
      ...current,
      ...(patch.apiKey ? { apiKey: patch.apiKey } : {}),
      ...(patch.baseUrl ? { baseUrl: patch.baseUrl } : {}),
      ...(patch.name ? { name: patch.name } : {}),
    });
    this.persist();
  }

  setModel(handle: string, caps: ModelCaps): void {
    this.modelEntries.set(handle, { ...caps });
    this.persist();
  }

  /**
   * Clears one declaration, and its endpoint group when it was the last model
   * under that prefix (nothing else renders from the group then).
   */
  removeModel(handle: string): boolean {
    if (!this.modelEntries.delete(handle)) return false;
    const cut = handle.indexOf("/");
    const prefix = cut > 0 ? handle.slice(0, cut) : "";
    const stillUsed = prefix !== "" && this.declaredPrefixes().has(prefix);
    if (prefix !== "" && !stillUsed) this.endpointEntries.delete(prefix);
    this.persist();
    return true;
  }

  /**
   * One-time migration seed: the legacy `VISION_PROVIDERS` env becomes store
   * entries on first boot so an existing deployment keeps working. Runs only
   * when there is no store file yet; nothing else reads the env after that.
   */
  seedFromVisionProviders(providers: readonly VisionProviderConfig[]): number {
    if (this.seededFrom === "file" || this.modelEntries.size > 0 || providers.length === 0) {
      return 0;
    }
    for (const provider of providers) {
      this.endpointEntries.set(provider.id, {
        baseUrl: provider.baseUrl,
        ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
        ...(provider.name ? { name: provider.name } : {}),
      });
      for (const model of provider.models) {
        this.modelEntries.set(`${provider.id}/${model.id}`, {
          vision: (model.input ?? ["text", "image"]).includes("image"),
          thinking: model.reasoning === true,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        });
      }
    }
    this.persist();
    return this.modelEntries.size;
  }

  /** Resolves once every queued write has settled; never rejects. */
  drain(): Promise<void> {
    return this.writeQueue;
  }

  private persist(): void {
    const snapshot = JSON.stringify(
      {
        models: Object.fromEntries(this.modelEntries),
        endpoints: Object.fromEntries(this.endpointEntries),
      },
      null,
      2,
    );
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => {
        try {
          mkdirSync(dirname(this.filePath), { recursive: true });
          const temp = `${this.filePath}.tmp`;
          writeFileSync(temp, snapshot);
          renameSync(temp, this.filePath);
        } catch (error) {
          this.onWriteError(error);
        }
      });
  }
}
