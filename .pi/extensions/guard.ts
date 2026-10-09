/**
 * Harness guardrails for the lettuce repo.
 *
 * `AGENTS.md` forbids a short list of operations in prose. Prose is forgotten at
 * turn 60, so this extension makes the harness enforce the same list: every
 * entry is either confirmed with the operator or blocked outright. It is a
 * guardrail for what the agent types into `bash` / `edit` / `write`, not a
 * sandbox — a script that pushes internally (`bun run release`) is invisible
 * here, which is why `release.ts` carries its own typed confirmation.
 *
 * With no UI (print / JSON mode) a confirmation cannot be shown, so a gated
 * action is blocked rather than silently allowed.
 *
 * The rules themselves live in `scripts/guard-core.ts` (unit-tested); this file is
 * only the pi wiring. Loaded automatically from `.pi/extensions/`; see
 * docs/extensions.md. The rules are NOT kept here on purpose: pi loads every
 * direct file in `.pi/extensions/` as an extension, so a helper module without a
 * default factory export there fails the whole launch.
 */
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { reviewCommand, reviewPath } from "../../scripts/guard-core.ts";

/** Repo root: this file lives in `.pi/extensions/`. */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export default function guard(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      for (const { segment, rule } of reviewCommand(event.input.command ?? "")) {
        if (rule.hard) {
          return { block: true, reason: `${rule.title} is blocked: ${rule.message}` };
        }
        if (!ctx.hasUI) {
          return {
            block: true,
            reason: `${rule.title} needs the operator's confirmation and there is no UI here (${ctx.mode} mode). Ask them, or have them run it.`,
          };
        }
        const ok = await ctx.ui.confirm(rule.title, `${segment}\n\n${rule.message}`);
        if (!ok) return { block: true, reason: `${rule.title} declined by the operator` };
      }
      return;
    }

    if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
      const file = reviewPath(event.input.path, ctx.cwd, ROOT);
      if (!file) return;
      if (file.hard) {
        return { block: true, reason: `${file.title} is protected: ${file.message}` };
      }
      if (!ctx.hasUI) {
        return {
          block: true,
          reason: `Writing ${file.title} needs confirmation and there is no UI here (${ctx.mode} mode).`,
        };
      }
      const ok = await ctx.ui.confirm(`Edit ${file.title}`, file.message);
      if (!ok) return { block: true, reason: `Edit of ${file.title} declined by the operator` };
    }
  });
}
