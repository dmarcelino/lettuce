import { describe, expect, test } from "bun:test";
import { parseVisionProviders, renderProvidersMod, VisionProvidersError } from "./vision.ts";

const HALOGEN =
  '[{"id":"halogen","name":"Halogen","description":"Qwen3.8-Flash-Next on Strix Halo",' +
  '"baseUrl":"http://192.168.6.100:8080/olla/openai/v1",' +
  '"models":[{"id":"Qwen3.8-Flash-Next","contextWindow":262144,"maxTokens":32768}]}]';

describe("parseVisionProviders", () => {
  test("unset or blank means no providers, not an error", () => {
    expect(parseVisionProviders(undefined)).toEqual([]);
    expect(parseVisionProviders("")).toEqual([]);
    expect(parseVisionProviders("   ")).toEqual([]);
  });

  test("a well-formed halogen entry parses with vision defaults", () => {
    const provider = parseVisionProviders(HALOGEN)[0]!;
    expect(provider.id).toBe("halogen");
    expect(provider.baseUrl).toBe("http://192.168.6.100:8080/olla/openai/v1");
    expect(provider.apiKey).toBeUndefined();
    const model = provider.models[0]!;
    expect(model.input).toEqual(["text", "image"]);
    expect(model.contextWindow).toBe(262144);
    expect(model.maxTokens).toBe(32768);
    expect(model.reasoning).toBeUndefined();
  });

  test("bad input names the mistake", () => {
    expect(() => parseVisionProviders("{oops")).toThrow(VisionProvidersError);
    expect(() => parseVisionProviders("{}")).toThrow(/JSON array/);
    expect(() =>
      parseVisionProviders(
        '[{"id":"Bad Id","baseUrl":"http://x/v1","models":[{"id":"m","contextWindow":1,"maxTokens":1}]}]',
      ),
    ).toThrow(/provider id/);
    expect(() =>
      parseVisionProviders(
        '[{"id":"p","baseUrl":"ftp://x","models":[{"id":"m","contextWindow":1,"maxTokens":1}]}]',
      ),
    ).toThrow(/baseUrl/);
    expect(() => parseVisionProviders('[{"id":"p","baseUrl":"http://x","models":[]}]')).toThrow(
      /non-empty/,
    );
    expect(() =>
      parseVisionProviders(
        '[{"id":"p","baseUrl":"http://x","models":[{"id":"a/b","contextWindow":1,"maxTokens":1}]}]',
      ),
    ).toThrow(/invalid id/);
    expect(() =>
      parseVisionProviders(
        '[{"id":"p","baseUrl":"http://x","models":[{"id":"m","contextWindow":0,"maxTokens":1}]}]',
      ),
    ).toThrow(/contextWindow/);
    expect(() =>
      parseVisionProviders(
        '[{"id":"p","baseUrl":"http://x","models":[{"id":"m","contextWindow":8192,"maxTokens":"1"}]}]',
      ),
    ).toThrow(/maxTokens/);
    expect(() =>
      parseVisionProviders(
        '[{"id":"p","baseUrl":"http://x","models":[{"id":"m","contextWindow":1,"maxTokens":1,"input":["video"]}]}]',
      ),
    ).toThrow(/input/);
    expect(() =>
      parseVisionProviders(
        '[{"id":"p","baseUrl":"http://x","models":[{"id":"m","contextWindow":1,"maxTokens":1}]},{"id":"p","baseUrl":"http://y","models":[{"id":"n","contextWindow":1,"maxTokens":1}]}]',
      ),
    ).toThrow(/twice/);
  });
});

describe("renderProvidersMod", () => {
  test("empty config renders a mod that registers nothing", () => {
    const source = renderProvidersMod([]);
    expect(source).toContain("registers nothing");
    expect(source).toContain("export default function activate() {}");
  });

  test("the rendered mod declares vision, the real window and no connect step", () => {
    const source = renderProvidersMod(parseVisionProviders(HALOGEN));
    expect(source).toContain('letta.providers.register("halogen"');
    expect(source).toContain('"input": [');
    expect(source).toContain('"text"');
    expect(source).toContain('"contextWindow": 262144');
    expect(source).toContain('"maxTokens": 32768');
    expect(source).toContain('"apiKey": "not-needed"');
    expect(source).toContain('"connect": false');
    expect(source).toContain('"api": "openai-completions"');
    // Execute the rendered mod the way the mod engine would: its default
    // export must call register with the right payload, and tolerate a host
    // without provider capabilities.
    const activate = new Function(source.replace("export default", "return"))() as (
      letta: unknown,
    ) => void;
    expect(() => activate({ capabilities: {} })).not.toThrow();
    const calls: [string, Record<string, unknown>][] = [];
    activate({
      capabilities: { providers: true },
      providers: {
        register: (id: string, reg: Record<string, unknown>) => void calls.push([id, reg]),
      },
    });
    expect(calls).toHaveLength(1);
    const [id, registration] = calls[0]!;
    expect(id).toBe("halogen");
    expect(registration.baseUrl).toBe("http://192.168.6.100:8080/olla/openai/v1");
    const models = registration.models as { input: string[]; contextWindow: number }[];
    expect(models[0]!.input).toEqual(["text", "image"]);
    expect(models[0]!.contextWindow).toBe(262144);
  });
});
