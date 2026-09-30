import { describe, expect, test } from "bun:test";
import {
  applyClaudeSettingsUpdate,
  DEFAULT_CLAUDE_SETTINGS,
  InvalidClaudeSettingsError,
  parseStoredClaudeSettings,
  renderStoredClaudeSettings,
  toPublicClaudeSettings,
} from "./settings.ts";

describe("parseStoredClaudeSettings", () => {
  test("absent, broken or non-object files fall back to defaults", () => {
    expect(parseStoredClaudeSettings(null)).toEqual(DEFAULT_CLAUDE_SETTINGS);
    expect(parseStoredClaudeSettings("{broken")).toEqual(DEFAULT_CLAUDE_SETTINGS);
    expect(parseStoredClaudeSettings("[1]")).toEqual(DEFAULT_CLAUDE_SETTINGS);
  });

  test("fills gaps in a hand-edited file", () => {
    const parsed = parseStoredClaudeSettings(JSON.stringify({ enabled: true, model: " m " }));
    expect(parsed).toEqual({ enabled: true, baseUrl: "", model: "m", authToken: null });
  });
});

describe("applyClaudeSettingsUpdate", () => {
  const READY = { baseUrl: "http://proxy:4000", model: "claude-sonnet-4-5" };

  test("enabling requires an endpoint and a model", () => {
    expect(() => applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, { enabled: true })).toThrow(
      InvalidClaudeSettingsError,
    );
    const next = applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, { ...READY, enabled: true });
    expect(next.enabled).toBe(true);
  });

  test("the token is write-only: absent keeps it, empty clears it", () => {
    const withToken = applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, {
      ...READY,
      authToken: "sk-secret",
    });
    expect(withToken.authToken).toBe("sk-secret");
    expect(applyClaudeSettingsUpdate(withToken, { model: "m2" }).authToken).toBe("sk-secret");
    expect(applyClaudeSettingsUpdate(withToken, { authToken: "" }).authToken).toBeNull();
  });

  test("the endpoint must be an http(s) URL, trailing slashes are trimmed", () => {
    expect(() =>
      applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, { baseUrl: "proxy:4000" }),
    ).toThrow(InvalidClaudeSettingsError);
    expect(
      applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, { baseUrl: "http://h:1/v1/" }).baseUrl,
    ).toBe("http://h:1/v1");
  });

  test("a round trip through the stored file keeps every field", () => {
    const saved = applyClaudeSettingsUpdate(DEFAULT_CLAUDE_SETTINGS, {
      ...READY,
      enabled: true,
      authToken: "sk-secret",
    });
    expect(parseStoredClaudeSettings(renderStoredClaudeSettings(saved))).toEqual(saved);
  });

  test("the public view never carries the token", () => {
    const publicSettings = toPublicClaudeSettings({
      ...DEFAULT_CLAUDE_SETTINGS,
      authToken: "sk-secret",
    });
    expect(publicSettings).not.toHaveProperty("authToken");
    expect(publicSettings.hasAuthToken).toBe(true);
  });
});
