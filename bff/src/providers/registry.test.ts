import { describe, expect, test } from "bun:test";
import {
  PROVIDER_TYPES,
  ProviderError,
  parseProviderBody,
  partitionModelIds,
  probeProviderModels,
  providerType,
  slugifyName,
} from "./registry.ts";
import { modModelIdProblem } from "./vision.ts";

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "llama 3b",
    type: "llama-cpp",
    baseUrl: "http://host.docker.internal:8080/v1",
    apiKey: "",
    models: ["qwen3-4b-instruct"],
    ...overrides,
  };
}

describe("slugifyName", () => {
  test("a name becomes a handle prefix", () => {
    expect(slugifyName("  Llama 3b ")).toBe("llama-3b");
    expect(slugifyName("Claude Work 🤖")).toBe("claude-work");
    expect(slugifyName("OpenRouter")).toBe("openrouter");
  });

  test("nothing left after folding is not a prefix", () => {
    expect(slugifyName("!!!")).toBe("");
    expect(slugifyName(undefined)).toBe("");
  });
});

describe("parseProviderBody", () => {
  test("the type decides the api and the group", () => {
    const parsed = parseProviderBody(body());
    expect(parsed).toMatchObject({
      prefix: "llama-3b",
      type: "llama-cpp",
      api: "openai-completions",
      scope: "local",
      baseUrl: "http://host.docker.internal:8080/v1",
      apiKey: null,
      models: ["qwen3-4b-instruct"],
    });
  });

  test("a trailing slash never doubles up in the base URL", () => {
    expect(parseProviderBody(body({ baseUrl: "https://api.x.ai/v1///" })).baseUrl).toBe(
      "https://api.x.ai/v1",
    );
  });

  test("a hosted type needs a key, a local one does not", () => {
    expect(() => parseProviderBody(body({ type: "anthropic" }))).toThrow(ProviderError);
    expect(parseProviderBody(body({ type: "anthropic", apiKey: " sk-key " })).apiKey).toBe(
      "sk-key",
    );
  });

  test("a saved provider may be re-saved without retyping the key", () => {
    expect(
      parseProviderBody(body({ type: "anthropic", apiKey: "" }), { stored: true }).apiKey,
    ).toBeNull();
  });

  test("the mistakes are said in the operator's words", () => {
    expect(() => parseProviderBody(body({ name: "   " }))).toThrow(/needs a name/);
    expect(() => parseProviderBody(body({ name: "///" }))).toThrow(/handle prefix/);
    expect(() => parseProviderBody(body({ type: "bedrock" }))).toThrow(/provider type/);
    expect(() => parseProviderBody(body({ baseUrl: "127.0.0.1:8080" }))).toThrow(/http/);
    expect(() => parseProviderBody(body({ models: [] }))).toThrow(/at least one model/);
    expect(() => parseProviderBody(body({ models: ["ok", "~nope"] }))).toThrow(/not a model id/);
    // What a model can do is not the provider's business: a body that still
    // carries capabilities gets them ignored rather than rejected.
    expect("caps" in parseProviderBody(body({ caps: { contextWindow: 0 } }))).toBe(false);
  });

  test("a model id holding a slash is refused: upstream's mod registration rejects it", () => {
    expect(() =>
      parseProviderBody(
        body({ type: "openai-compatible", baseUrl: "http://x/v1", models: ["org/model"] }),
      ),
    ).toThrow(/"org\/model".*"\/"/);
    expect(() => parseProviderBody(body({ models: ["~anthropic/claude-haiku-latest"] }))).toThrow(
      ProviderError,
    );
  });

  test("a type served by the app-server's own connection needs only its key", () => {
    const parsed = parseProviderBody({ type: "openrouter", apiKey: " k " });
    expect(parsed.connection).toBe("openrouter");
    // The handle prefix is the connection's, not a name the operator chose.
    expect(parsed.prefix).toBe("openrouter");
    expect(parsed.apiKey).toBe("k");
    expect(parsed.models).toEqual([]);
    expect(() => parseProviderBody({ type: "openrouter" })).toThrow(/needs an API key/);
  });

  test("a connection keeps a custom endpoint and sends none for the catalog's", () => {
    // A stored URL replaces every catalog model's own base, so the default is
    // never stored: OpenRouter's Claude models live on `…/api`, not `…/api/v1`.
    for (const baseUrl of [
      undefined,
      "",
      "https://openrouter.ai/api/v1",
      "https://openrouter.ai/api/v1/",
    ]) {
      expect(parseProviderBody({ type: "openrouter", apiKey: "k", baseUrl }).baseUrl).toBe("");
    }
    expect(
      parseProviderBody({
        type: "openrouter",
        apiKey: "k",
        baseUrl: "https://eu.openrouter.ai/api/v1/",
      }).baseUrl,
    ).toBe("https://eu.openrouter.ai/api/v1");
    expect(() =>
      parseProviderBody({ type: "openrouter", apiKey: "k", baseUrl: "openrouter.ai" }),
    ).toThrow(/http/);
  });

  test("a provider named before its type became a connection is still parsed as one", () => {
    const parsed = parseProviderBody(
      body({
        name: "Groq",
        type: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: "k",
        models: ["llama-3.1-8b-instant"],
      }),
      { stored: true },
    );
    expect(parsed.connection).toBeUndefined();
    expect(parsed.prefix).toBe("groq");
    expect(parsed.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(parsed.models).toEqual(["llama-3.1-8b-instant"]);
  });

  test("every catalog whose ids carry a slash goes through the app-server's connection", () => {
    expect(
      PROVIDER_TYPES.filter((type) => type.connection)
        .map((type) => type.id)
        .sort(),
    ).toEqual([
      "baseten",
      "fireworks",
      "groq",
      "huggingface",
      "nvidia",
      "openrouter",
      "together",
      "vercel-ai-gateway",
    ]);
  });

  test("every type says an api and a scope", () => {
    for (const type of PROVIDER_TYPES) {
      expect(providerType(type.id)).toBe(type);
      expect(type.api).toMatch(/^(openai|anthropic|google|mistral)/);
      expect(["local", "cloud"]).toContain(type.scope);
    }
    expect(providerType("bedrock")).toBeUndefined();
  });
});

describe("parseProviderBody headers", () => {
  test("absent means nothing said: the stored set survives", () => {
    expect(parseProviderBody(body()).headers).toBeUndefined();
    expect(parseProviderBody(body({ headers: null })).headers).toBeUndefined();
  });

  test("a present map is the complete new set; blank pairs drop", () => {
    expect(
      parseProviderBody(body({ headers: { "x-session": " abc ", "x-blank": "" } })).headers,
    ).toEqual({ "x-session": "abc" });
    expect(parseProviderBody(body({ headers: {} })).headers).toEqual({});
  });

  test("a name is an HTTP token and a value one printable line", () => {
    expect(() => parseProviderBody(body({ headers: { "x bad": "v" } }))).toThrow(/header name/);
    expect(() => parseProviderBody(body({ headers: { "x-cr": "a\rb\nc" } }))).toThrow(
      /single printable line/,
    );
    expect(() => parseProviderBody(body({ headers: ["x-a"] }))).toThrow(/name to value/);
    // An empty name carrying a value is a mistake the save should name.
    expect(() => parseProviderBody(body({ headers: { "": "v" } }))).toThrow(/header name/);
  });
});

describe("modModelIdProblem", () => {
  test("served ids upstream registers pass", () => {
    for (const id of ["qwen3-4b-instruct", "Qwen3.8-Flash-Next", "llama3.1:8b", "gpt-4o_mini"]) {
      expect(modModelIdProblem(id)).toBeNull();
    }
  });

  test("a slash or a leading sigil is named as the reason", () => {
    expect(modModelIdProblem("deepseek/deepseek-v3")).toMatch(/"\/"/);
    expect(modModelIdProblem("~anthropic/claude-haiku-latest")).not.toBeNull();
    expect(modModelIdProblem("~latest")).not.toBeNull();
    expect(modModelIdProblem("")).not.toBeNull();
  });

  test("partitionModelIds keeps what registers and counts the rest", () => {
    expect(partitionModelIds(["a", "~x/y", "b/c", "d"])).toEqual({
      models: ["a", "d"],
      skipped: ["~x/y", "b/c"],
    });
  });
});

describe("probeProviderModels", () => {
  /** Every family asks differently; a wrong ask reads as "no models". */
  async function withFetch(
    payload: unknown,
    run: (calls: { url: string; headers: Record<string, string> }[]) => Promise<void>,
  ) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const init = args[1] as RequestInit | undefined;
      calls.push({
        url: typeof args[0] === "string" ? args[0] : args[0].toString(),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;
    try {
      await run(calls);
    } finally {
      globalThis.fetch = real;
    }
  }

  test("the OpenAI-shaped ask is the base URL plus /models, with a bearer", async () => {
    await withFetch({ data: [{ id: "b" }, { id: "a" }] }, async (calls) => {
      const ids = await probeProviderModels({
        api: "openai-completions",
        baseUrl: "http://x:8080/v1",
        apiKey: "k",
      });
      expect(ids).toEqual(["a", "b"]);
      expect(calls[0]!.url).toBe("http://x:8080/v1/models");
      expect(calls[0]!.headers.authorization).toBe("Bearer k");
    });
  });

  test("Anthropic wants /v1/models with its own headers", async () => {
    await withFetch({ data: [{ id: "claude-sonnet-4-5" }] }, async (calls) => {
      expect(
        await probeProviderModels({
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          apiKey: "k",
        }),
      ).toEqual(["claude-sonnet-4-5"]);
      expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models");
      expect(calls[0]!.headers["x-api-key"]).toBe("k");
      expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    });
  });

  test("an Anthropic base URL that already carries /v1 is not doubled", async () => {
    await withFetch({ data: ["x"] }, async (calls) => {
      await probeProviderModels({
        api: "anthropic-messages",
        baseUrl: "https://proxy.test/v1",
        apiKey: "k",
      });
      expect(calls[0]!.url).toBe("https://proxy.test/v1/models");
    });
  });

  test("Gemini takes the key in the query and names its models", async () => {
    await withFetch({ models: [{ name: "models/gemini-2.0-flash" }] }, async (calls) => {
      expect(
        await probeProviderModels({
          api: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "k",
        }),
      ).toEqual(["gemini-2.0-flash"]);
      expect(calls[0]!.url).toContain("/v1beta/models?key=k");
    });
  });

  test("custom headers join the ask and can override the defaults", async () => {
    await withFetch({ data: ["m"] }, async (calls) => {
      await probeProviderModels({
        api: "openai-completions",
        baseUrl: "http://x:8080/v1",
        apiKey: "k",
        headers: { "cf-access-client-id": "id", authorization: "Bearer tunnel" },
      });
      expect(calls[0]!.headers["cf-access-client-id"]).toBe("id");
      // The operator's header wins — that is how an Access token replaces a key.
      expect(calls[0]!.headers.authorization).toBe("Bearer tunnel");
    });
  });

  test("a long catalog comes back whole: a cut would read as models the host delisted", async () => {
    const data = Array.from({ length: 450 }, (_, i) => ({
      id: `vendor/model-${String(i).padStart(3, "0")}`,
    }));
    await withFetch({ data }, async () => {
      const ids = await probeProviderModels({
        api: "openai-completions",
        baseUrl: "http://x/v1",
        apiKey: "k",
      });
      expect(ids).toHaveLength(450);
      expect(ids.at(-1)).toBe("vendor/model-449");
    });
  });

  test("a list past any real catalog is refused, not cut and not echoed whole", async () => {
    const data = Array.from({ length: 5_001 }, (_, i) => ({ id: `m-${i}` }));
    await withFetch({ data }, async () => {
      await expect(
        probeProviderModels({ api: "openai-completions", baseUrl: "http://x/v1", apiKey: "k" }),
      ).rejects.toThrow(/more than 5000 models/);
    });
  });

  test("what the endpoint says comes back verbatim", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>) =>
      new Response("invalid api key", { status: 401 })) as typeof fetch;
    try {
      await expect(
        probeProviderModels({ api: "openai-completions", baseUrl: "http://x/v1", apiKey: "k" }),
      ).rejects.toThrow(/401.*invalid api key/);
    } finally {
      globalThis.fetch = real;
    }
  });
});
