/**
 * Pure logic of the `codex` shim (see ./codex-shim.mjs for why it exists).
 *
 * Kept free of side effects so `shim-core.test.ts` can exercise it; the entry
 * script only wires these functions to a child process.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Written by the BFF (`bff/src/codex/settings.ts`) next to Codex's own config. */
export const SETTINGS_FILE = "letta-ui.json";

export const DISABLED_MESSAGE =
  "Codex workers are disabled. Enable them in the web UI under Settings → Codex.";

/** `$CODEX_HOME`, else Codex's own default of `~/.codex`. */
export function codexHome(env) {
  return env.CODEX_HOME || join(env.HOME || "/root", ".codex");
}

/** The saved settings, or null when absent or unreadable — which means disabled. */
export function readShimSettings(home) {
  try {
    const parsed = JSON.parse(readFileSync(join(home, SETTINGS_FILE), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function isEnabled(settings) {
  return settings?.enabled === true;
}

/**
 * The container is the isolation boundary this stack keeps (see CLAUDE.md,
 * "letta-code's filesystem sandbox is OFF"), so Codex is told so rather than
 * asked to build its own bubblewrap sandbox inside it. Under an external
 * sandbox Codex enforces nothing itself — network included — so there is no
 * "restricted" option to offer: it would only be a hint to the model.
 */
export const EXTERNAL_SANDBOX_POLICY = Object.freeze({
  type: "externalSandbox",
  networkAccess: "enabled",
});

/**
 * Rewrite one JSON-RPC line from letta-code to Codex's app-server.
 *
 * letta-code sends `sandboxPolicy: {type: "workspaceWrite", …}` on every
 * `turn/start` (`tools/impl/codex-app-server.ts`, hard-coded). Only that field
 * changes; anything that is not JSON, or carries no `sandboxPolicy`, passes
 * through byte for byte.
 */
export function rewriteLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  if (!message || typeof message !== "object") return line;
  const params = message.params;
  if (!params || typeof params !== "object" || !("sandboxPolicy" in params)) return line;
  return JSON.stringify({
    ...message,
    params: { ...params, sandboxPolicy: EXTERNAL_SANDBOX_POLICY },
  });
}
