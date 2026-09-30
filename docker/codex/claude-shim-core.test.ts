import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Plain .mjs shipped in the app-server image; outside both packages' typecheck.
import * as shim from "./claude-shim-core.mjs";

describe("settings", () => {
  test("absent or unreadable settings mean disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-home-"));
    expect(shim.readShimSettings(dir)).toBeNull();
    expect(shim.isEnabled(null)).toBe(false);
    writeFileSync(join(dir, shim.SETTINGS_FILE), "{broken");
    expect(shim.readShimSettings(dir)).toBeNull();
  });

  test("only an explicit true enables", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-home-"));
    writeFileSync(join(dir, shim.SETTINGS_FILE), JSON.stringify({ enabled: true }));
    expect(shim.isEnabled(shim.readShimSettings(dir))).toBe(true);
    expect(shim.isEnabled({ enabled: "yes" })).toBe(false);
  });

  test("CLAUDE_CONFIG_DIR wins over the default", () => {
    expect(shim.claudeConfigDir({ CLAUDE_CONFIG_DIR: "/root/.letta/claude" })).toBe(
      "/root/.letta/claude",
    );
    expect(shim.claudeConfigDir({})).toBe("/root/.letta/claude");
  });
});

describe("buildEnv", () => {
  const SETTINGS = {
    enabled: true,
    baseUrl: "http://proxy:4000",
    model: "claude-sonnet-4-5",
    authToken: "sk-real",
  };

  test("injects the saved endpoint settings as the env Claude Code reads", () => {
    const env = shim.buildEnv(SETTINGS, {});
    expect(env).toMatchObject({
      CLAUDE_CONFIG_DIR: "/root/.letta/claude",
      ANTHROPIC_BASE_URL: "http://proxy:4000",
      ANTHROPIC_MODEL: "claude-sonnet-4-5",
      ANTHROPIC_AUTH_TOKEN: "sk-real",
    });
  });

  test("an empty settings file still yields a token that passes the preflight", () => {
    const env = shim.buildEnv({}, {});
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(shim.PLACEHOLDER_AUTH_TOKEN);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
  });

  test("what the environment already carries wins", () => {
    const env = shim.buildEnv(SETTINGS, {
      CLAUDE_CONFIG_DIR: "/elsewhere",
      ANTHROPIC_BASE_URL: "http://explicit:1",
      ANTHROPIC_MODEL: "explicit-model",
      ANTHROPIC_AUTH_TOKEN: "explicit-token",
    });
    expect(env).toMatchObject({
      CLAUDE_CONFIG_DIR: "/elsewhere",
      ANTHROPIC_BASE_URL: "http://explicit:1",
      ANTHROPIC_MODEL: "explicit-model",
      ANTHROPIC_AUTH_TOKEN: "explicit-token",
    });
  });
});
