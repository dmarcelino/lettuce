import { describe, expect, test } from "bun:test";
import {
  applyCodexSettingsUpdate,
  DEFAULT_CODEX_SETTINGS,
  InvalidCodexSettingsError,
  parseStoredCodexSettings,
  renderCodexAuthJson,
  renderCodexConfigToml,
  suggestCodexBaseUrl,
  toPublicCodexSettings,
} from "./settings.ts";

const READY = { baseUrl: "http://olla:8080/olla/openai/v1", model: "Qwen3.8-Flash-Next" };

describe("applyCodexSettingsUpdate", () => {
  test("enabling needs an endpoint and a model", () => {
    expect(() => applyCodexSettingsUpdate(DEFAULT_CODEX_SETTINGS, { enabled: true })).toThrow(
      InvalidCodexSettingsError,
    );
    const next = applyCodexSettingsUpdate(DEFAULT_CODEX_SETTINGS, { ...READY, enabled: true });
    expect(next.enabled).toBe(true);
  });

  test("the key is write-only: absent keeps it, empty clears it", () => {
    const withKey = applyCodexSettingsUpdate(DEFAULT_CODEX_SETTINGS, { ...READY, apiKey: "sk-1" });
    expect(applyCodexSettingsUpdate(withKey, { model: "other" }).apiKey).toBe("sk-1");
    expect(applyCodexSettingsUpdate(withKey, { apiKey: "" }).apiKey).toBeNull();
    expect(toPublicCodexSettings(withKey)).not.toHaveProperty("apiKey");
    expect(toPublicCodexSettings(withKey).hasApiKey).toBe(true);
  });

  test("bad values are refused, not coerced", () => {
    const bad = [
      { baseUrl: "ftp://x" },
      { reasoningEffort: "extreme" },
      { contextWindow: -5 },
      { contextWindow: 1.5 },
      { enabled: "yes" },
      [],
    ];
    for (const body of bad) {
      expect(() => applyCodexSettingsUpdate(DEFAULT_CODEX_SETTINGS, body)).toThrow(
        InvalidCodexSettingsError,
      );
    }
  });

  test("a trailing slash on the endpoint is dropped", () => {
    expect(
      applyCodexSettingsUpdate(DEFAULT_CODEX_SETTINGS, { baseUrl: "http://h/v1/" }).baseUrl,
    ).toBe("http://h/v1");
  });
});

describe("stored settings", () => {
  test("missing or broken files load as the disabled defaults", () => {
    expect(parseStoredCodexSettings(null)).toEqual(DEFAULT_CODEX_SETTINGS);
    expect(parseStoredCodexSettings("{nope")).toEqual(DEFAULT_CODEX_SETTINGS);
  });

  test("round-trips what was saved", () => {
    const saved = applyCodexSettingsUpdate(DEFAULT_CODEX_SETTINGS, {
      ...READY,
      enabled: true,
      reasoningEffort: "high",
      contextWindow: 262144,
    });
    expect(parseStoredCodexSettings(JSON.stringify(saved))).toEqual(saved);
  });
});

describe("rendered Codex files", () => {
  test("config.toml points Codex at the endpoint over the Responses API", () => {
    const toml = renderCodexConfigToml({
      ...DEFAULT_CODEX_SETTINGS,
      ...READY,
      apiKey: 'k"ey',
      reasoningEffort: "low",
      contextWindow: 1000,
      streamIdleTimeoutSeconds: 600,
    });
    expect(toml).toContain('model = "Qwen3.8-Flash-Next"');
    expect(toml).toContain('model_provider = "letta-ui"');
    expect(toml).toContain('base_url = "http://olla:8080/olla/openai/v1"');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('experimental_bearer_token = "k\\"ey"');
    expect(toml).toContain("model_context_window = 1000");
    expect(toml).toContain("stream_idle_timeout_ms = 600000");
  });

  test("optional keys are left out when unset", () => {
    const toml = renderCodexConfigToml({ ...DEFAULT_CODEX_SETTINGS, ...READY });
    expect(toml).not.toContain("experimental_bearer_token");
    expect(toml).not.toContain("model_reasoning_effort");
  });

  test("auth.json is Codex's API-key login shape", () => {
    expect(JSON.parse(renderCodexAuthJson())).toMatchObject({ auth_mode: "apikey" });
  });
});

test("the suggested endpoint is letta's own OpenAI-compatible provider", () => {
  const providers = JSON.stringify({
    providers: {
      "openai-compatible": { provider_type: "openai-compatible", base_url: "http://h:8080/v1/" },
    },
  });
  expect(suggestCodexBaseUrl(providers)).toBe("http://h:8080/v1");
  expect(suggestCodexBaseUrl(null)).toBeNull();
  expect(suggestCodexBaseUrl("garbage")).toBeNull();
});
