/**
 * Settings → Providers & models: what the operator added as a provider, and what
 * they declared about a model behind an endpoint that reports no capabilities of
 * its own (vision, reasoning, the real context window).
 *
 * Both live in one store and both drive the providers mod, which is the capability
 * truth for every prefix it registers — so a save here re-renders and reloads it,
 * and a declared window retunes every agent on that model (`session/context-size.ts`).
 * Keys stored here are write-only: no route echoes them.
 *
 * `index.ts` registers these where they sat, and its `requireSession` middleware
 * already gates `/api/*`.
 */

import type { Context, Hono } from "hono";
import { errorMessage } from "../errors.ts";
import type { RouteEnv } from "../route-env.ts";
import type { ContextSizer } from "../session/context-size.ts";
import {
  type ParsedProvider,
  PROVIDER_TYPES,
  ProviderError,
  parseHeaderMap,
  parseProviderBody,
  partitionModelIds,
  probeProviderModels,
  providerType,
  slugifyName,
} from "./registry.ts";
import type { ProviderSight } from "./sight.ts";
import { ModelCapsError, type ModelCapsStore, parseModelCapsBody, splitHandle } from "./store.ts";
import { modModelIdProblem, providerLoadErrors } from "./vision.ts";

export interface ProviderRouteDeps {
  /** A save writes the providers mod, which goes over the connection. */
  isReady: () => boolean;
  modelCaps: ModelCapsStore;
  providerSight: ProviderSight;
  contextSizer: ContextSizer;
  resyncMods: (
    reason: string,
    options: { refreshCatalog: boolean; refreshProviders?: boolean },
  ) => Promise<unknown>;
  /** `connect_provider` on the local target; throws with what upstream said. */
  connect: (providerId: string, apiKey: string) => Promise<void>;
  /** letta-code's mod diagnostics report (`MOD_DIAGNOSTICS_PATH`), or null. */
  readDiagnostics: () => Promise<string | null>;
}

/**
 * Why a provider of ours serves nothing (or less than it lists), or undefined.
 * Ids holding "/" come first: a provider saved before the shared id rule has
 * them, the render leaves them out, and no load error names them.
 */
function providerProblem(
  info: { type?: string; models?: string[] },
  loadError: string | undefined,
): string | undefined {
  const unregistrable = (info.models ?? []).filter((id) => modModelIdProblem(id) !== null);
  if (unregistrable.length > 0) {
    const count = unregistrable.length;
    const type = providerType(info.type);
    const what = `${count} ${count === 1 ? "model holds" : "models hold"} a "/", which a named provider cannot register`;
    return type?.connection
      ? `${what} — remove it and add ${type.label} again, which the app-server's own connection serves.`
      : `${what} — edit it and untick ${count === 1 ? "it" : "them"}.`;
  }
  return loadError;
}

export function registerProviderRoutes<Env extends RouteEnv>(
  app: Hono<Env>,
  deps: ProviderRouteDeps,
): void {
  const { isReady, modelCaps, providerSight, contextSizer, resyncMods, connect, readDiagnostics } =
    deps;

  // What the operator declares about models behind endpoints that report no
  // capabilities (plain OpenAI-compatible and its BYOK aliases): vision,
  // thinking, the real context window. The declarations drive the providers mod
  // — which is THE capability truth for every prefix it registers — so a save
  // re-renders and reloads it and answers with the same `mod` state the
  // web-tools switch uses ("reload-pending" when no agent exists yet).
  // Keys stored here are write-only: no route echoes them, same rule as the
  // provider connections themselves.

  app.get("/api/model-caps", (c) => {
    // Endpoint snapshots minus the key: a declared provider no Settings
    // connection owns (an env-seeded one like halogen) still needs its URL and
    // name to render as a served model. Keys stay write-only, same as everywhere.
    const endpoints = Object.fromEntries(
      Object.entries(modelCaps.endpoints()).map(([prefix, info]) => [
        prefix,
        {
          ...(info.baseUrl ? { baseUrl: info.baseUrl } : {}),
          ...(info.name ? { name: info.name } : {}),
        },
      ]),
    );
    return c.json({ models: modelCaps.models(), endpoints });
  });

  app.put("/api/model-caps", async (c) => {
    if (!isReady()) return c.text("App-server is not connected", 503);
    let saved: ReturnType<typeof parseModelCapsBody>;
    try {
      saved = parseModelCapsBody(await c.req.json().catch(() => null));
    } catch (error) {
      if (error instanceof ModelCapsError) return c.text(error.message, 400);
      return c.text(errorMessage(error), 400);
    }
    const prefix = saved.handle.slice(0, saved.handle.indexOf("/"));
    // A declaration shadows the whole prefix, and a shadow must list every served
    // model; one the mod cannot register means the shadow would refuse to load.
    const unshadowable = providerSight
      .servedModels(prefix)
      ?.find((model) => modModelIdProblem(model.id) !== null);
    if (unshadowable) {
      return c.text(
        `${prefix}/ also serves "${unshadowable.id}", which a named provider cannot register, so no model of it can be declared here — its connection reports its own capabilities.`,
        400,
      );
    }
    modelCaps.setModel(saved.handle, saved.caps);
    // Snapshot what the live connection currently has, so the group survives
    // the connection going away; a blank key keeps the stored one (the protocol
    // can never read it back, so the save form starts blank every time).
    const baseUrl = providerSight.baseUrlFor(prefix);
    modelCaps.setEndpoint(prefix, {
      ...(saved.apiKey ? { apiKey: saved.apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });
    // Awaited so the answer says whether it is live; the reload retries on its
    // own while no agent exists to carry it.
    const mod = await resyncMods("Settings → model capabilities", {
      refreshCatalog: false,
      refreshProviders: true,
    }).catch(() => null);
    // A different declared window moves the point where the engine refuses, so
    // every agent on this model is retuned to it (session/context-size.ts).
    void contextSizer.applyHandle(saved.handle).catch(() => {});
    return c.json({ model: { handle: saved.handle, ...saved.caps }, mod: mod ?? "failed" });
  });

  app.delete("/api/model-caps", async (c) => {
    if (!isReady()) return c.text("App-server is not connected", 503);
    const parts = splitHandle(c.req.query("handle"));
    if (!parts) return c.text('handle must look like "provider/model"', 400);
    const removed = modelCaps.removeModel(`${parts.prefix}/${parts.model}`);
    const mod = await resyncMods("Settings → model capabilities", {
      refreshCatalog: false,
      refreshProviders: true,
    }).catch(() => null);
    return c.json({ removed, mod: mod ?? "failed" });
  });

  // The providers the operator added (Settings → Providers & models). Each is a
  // named endpoint with a handle prefix of its own, registered by the providers
  // mod — see `providers/registry.ts` for why this cannot be `connect_provider`.
  // The list never carries a key; a save with a blank key keeps the stored one.

  app.get("/api/providers", async (c) => {
    const loadErrors = providerLoadErrors(await readDiagnostics().catch(() => null));
    const providers = Object.entries(modelCaps.endpoints()).map(([prefix, info]) => {
      const problem = providerProblem(info, loadErrors.get(prefix));
      return {
        prefix,
        name: info.name ?? prefix,
        type: info.type ?? "",
        api: info.api ?? "openai-completions",
        scope: info.scope ?? "local",
        baseUrl: info.baseUrl ?? "",
        models: info.models ?? [],
        hasKey: Boolean(info.apiKey),
        // Names only: a header value is a secret like a key, and this list is
        // what the edit form shows before anything is typed.
        headerNames: Object.keys(info.headers ?? {}).sort(),
        ...(problem ? { problem } : {}),
      };
    });
    return c.json({ types: PROVIDER_TYPES, providers });
  });

  app.post("/api/providers", async (c) => {
    if (!isReady()) return c.text("App-server is not connected", 503);
    let parsed: ParsedProvider;
    try {
      parsed = parseProviderBody(await c.req.json().catch(() => null));
    } catch (error) {
      if (error instanceof ProviderError) return c.text(error.message, 400);
      return c.text(errorMessage(error), 400);
    }
    const stored = modelCaps.endpoints()[parsed.prefix];
    if (parsed.connection) return connectProvider(c, parsed, stored !== undefined);
    if (stored?.name && stored.name !== parsed.name) {
      return c.text(
        `Another provider already answers to "${parsed.name}" — two providers cannot share the handle ${parsed.prefix}.`,
        409,
      );
    }
    if (!stored && providerSight.isConnected(parsed.prefix)) {
      return c.text(
        `The app-server already has a connection serving ${parsed.prefix}/ — name the provider something else.`,
        409,
      );
    }
    modelCaps.unretire(parsed.prefix);
    modelCaps.setEndpoint(parsed.prefix, {
      name: parsed.name,
      type: parsed.type,
      api: parsed.api,
      scope: parsed.scope,
      baseUrl: parsed.baseUrl,
      models: parsed.models,
      ...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
      ...(parsed.headers !== undefined ? { headers: parsed.headers } : {}),
    });
    // Nothing here declares what a model can do — vision, reasoning and the real
    // context window are per model and set on the model, so a save here must not
    // write (or flatten) a single capability.
    const reloadStarted = Date.now();
    const mod = await resyncMods("Settings → providers", {
      refreshCatalog: false,
      refreshProviders: true,
    }).catch(() => null);
    // A reload answers success even when the app-server refused the registration;
    // only its diagnostics report says so, and only one written by this reload counts.
    const loadError =
      mod === "reloaded"
        ? providerLoadErrors(await readDiagnostics().catch(() => null), reloadStarted).get(
            parsed.prefix,
          )
        : undefined;
    return c.json({
      provider: {
        prefix: parsed.prefix,
        name: parsed.name,
        type: parsed.type,
        api: parsed.api,
        scope: parsed.scope,
        baseUrl: parsed.baseUrl,
        models: parsed.models,
        headerNames: Object.keys(
          parsed.headers ?? modelCaps.endpoint(parsed.prefix)?.headers ?? {},
        ).sort(),
      },
      mod: mod ?? "failed",
      ...(loadError ? { loadError } : {}),
    });
  });

  /**
   * A type the app-server's own connection serves (`ProviderType.connection`):
   * the key goes to `connect_provider` and nothing is stored or rendered here.
   * Upstream's connect is create-or-update, so an existing connection is refused
   * rather than having its key silently replaced — its row's Edit does that.
   */
  async function connectProvider(c: Context, parsed: ParsedProvider, ownedHere: boolean) {
    const providerId = parsed.connection as string;
    if (ownedHere) {
      return c.text(
        `A provider of yours already uses the handle ${parsed.prefix}/ — remove it before connecting ${parsed.name}.`,
        409,
      );
    }
    if (providerSight.isConnected(providerId)) {
      return c.text(
        `${parsed.name} is already connected — use Edit on its row to change the key.`,
        409,
      );
    }
    try {
      await connect(providerId, parsed.apiKey ?? "");
    } catch (error) {
      return c.text(errorMessage(error), 502);
    }
    await providerSight.refresh().catch(() => {});
    return c.json({
      provider: {
        prefix: parsed.prefix,
        name: parsed.name,
        type: parsed.type,
        api: parsed.api,
        scope: parsed.scope,
        baseUrl: parsed.baseUrl,
        models: parsed.models,
        connection: providerId,
      },
      mod: "unchanged",
    });
  }

  app.delete("/api/providers", async (c) => {
    if (!isReady()) return c.text("App-server is not connected", 503);
    const prefix = slugifyName(c.req.query("prefix"));
    if (!prefix) return c.text("prefix is required", 400);
    const removed = modelCaps.removeProvider(prefix);
    const mod = await resyncMods("Settings → providers", {
      refreshCatalog: false,
      refreshProviders: true,
    }).catch(() => null);
    return c.json({ removed, mod: mod ?? "failed" });
  });

  /**
   * What an endpoint says it serves. POST with the key in the body, not a query
   * string: a URL is the one thing that ends up in logs.
   */
  /**
   * What a probe is asked about: the endpoint fields of the form, with a blank
   * key falling back to the stored one — an edit form starts blank every time
   * because nothing can read a key back. The header rows typed so far join the
   * stored set (same fallback rule); when the form sent no `headers` field at
   * all, the stored set probes as-is.
   */
  async function probeFields(c: Context): Promise<{
    api: string;
    baseUrl: string;
    key: string;
    headers: Record<string, string>;
    connection: boolean;
  }> {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const typed = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    const prefix = slugifyName(body?.prefix);
    const key = typed || (prefix ? (modelCaps.endpoints()[prefix]?.apiKey ?? "") : "");
    const stored = (prefix ? modelCaps.endpoints()[prefix]?.headers : undefined) ?? {};
    let headers = stored;
    if (body?.headers !== undefined && body.headers !== null) {
      try {
        headers = { ...stored, ...parseHeaderMap(body.headers) };
      } catch {
        // A probe only reports: a malformed row is refused by the save, and a
        // probe with whatever the rest of the form says is still useful.
      }
    }
    return {
      api: typeof body?.api === "string" ? body.api : "openai-completions",
      baseUrl: typeof body?.baseUrl === "string" ? body.baseUrl : "",
      key,
      headers,
      connection: Boolean(providerType(body?.type)?.connection),
    };
  }

  /** A failed probe says what the endpoint said — it is the operator's to read. */
  function providerText(error: unknown): string {
    return error instanceof ProviderError ? error.message : errorMessage(error);
  }

  app.post("/api/providers/models", async (c) => {
    const probe = await probeFields(c);
    if (!probe.baseUrl) return c.text("baseUrl is required", 400);
    try {
      const models = await probeProviderModels({
        api: probe.api,
        baseUrl: probe.baseUrl,
        apiKey: probe.key,
        headers: probe.headers,
      });
      // A connection serves its own catalog, so its probe only proves the key; a
      // named provider is offered only ids the mod can register.
      return c.json(probe.connection ? { models, skipped: [] } : partitionModelIds(models));
    } catch (error) {
      return c.text(providerText(error), 400);
    }
  });
}
