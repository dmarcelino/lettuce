/**
 * Pure logic of the `claude` shim (see ./claude-shim.mjs for why it exists).
 *
 * Kept free of side effects so `claude-shim-core.test.ts` can exercise it; the
 * entry script only wires these functions to a child process.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Written by the BFF (`bff/src/claude/settings.ts`) in Claude's config dir. */
export const SETTINGS_FILE = "letta-ui.json";

export const DISABLED_MESSAGE =
  "Claude Code workers are disabled. Enable them in the web UI under Settings → Claude Code.";

/**
 * `$CLAUDE_CONFIG_DIR`, else where compose points it (the letta-home mount, so
 * transcripts survive recreates and the BFF can read them).
 */
export const CLAUDE_CONFIG_DIR = "/root/.letta/claude";

/**
 * Satisfies `claude auth status --json` (the preflight letta-code runs: it
 * needs `loggedIn: true`, which any `ANTHROPIC_AUTH_TOKEN` value gives —
 * measured on 2.1.285) when no token was configured. A proxy that checks the
 * token rejects it at request time, which is the honest failure; a proxy that
 * ignores auth never sees a difference.
 */
export const PLACEHOLDER_AUTH_TOKEN = "lettuce-placeholder-not-an-anthropic-key";

/** Where Claude's config (and `projects/` transcripts) live for this run. */
export function claudeConfigDir(env) {
  return env.CLAUDE_CONFIG_DIR || CLAUDE_CONFIG_DIR;
}

/** The saved settings, or null when absent or unreadable — which means disabled. */
export function readShimSettings(configDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, SETTINGS_FILE), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function isEnabled(settings) {
  return settings?.enabled === true;
}

/**
 * The environment for the real CLI. Claude Code has no config file of its own
 * for the endpoint — it reads these four variables — so the settings the BFF
 * saved are injected here rather than rendered into a file. Anything already
 * in the environment wins: compose sets `CLAUDE_CONFIG_DIR`, and an operator
 * who exports a value in the container means it.
 */
export function buildEnv(settings, env) {
  const next = { ...env };
  next.CLAUDE_CONFIG_DIR ||= CLAUDE_CONFIG_DIR;
  if (settings.baseUrl) next.ANTHROPIC_BASE_URL ||= settings.baseUrl;
  if (settings.model) next.ANTHROPIC_MODEL ||= settings.model;
  next.ANTHROPIC_AUTH_TOKEN ||= settings.authToken || PLACEHOLDER_AUTH_TOKEN;
  return next;
}
