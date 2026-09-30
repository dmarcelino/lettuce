/**
 * The mod that keeps Codex and Claude Code workers away from agents blocked in
 * Agent → Tools (`agents/tool-access.ts`).
 *
 * A Codex worker is not a tool of its own: it is `Task` / `Agent` with
 * `subagent_type: "codex"`, and a follow-up is `SendAgentMessage` to a
 * `codex_<thread id>` agent; a Claude Code worker is the same with
 * `subagent_type: "claude-code"` and `claude_<session id>` (letta-code
 * `EXTERNAL_AGENT_ID_PREFIXES`). So this is a mod permission, not a hidden
 * tool — `letta.permissions.register` sees the calling agent and the
 * arguments, and its `deny` replaces the built-in decision in every permission
 * mode, Unrestricted included (letta-code `permissions/checker.ts`
 * `checkPermissionWithHooks`). It matches on the arguments, not the tool name,
 * so a renamed launcher is still covered.
 *
 * The blocked lists are baked in; a change re-renders the file and reloads mods.
 */

import { MODS_DIR } from "../internal-tools/mod.ts";

export const AGENT_POLICY_MOD_PATH = `${MODS_DIR}/letta-ui-agent-policy.mjs`;

export const CODEX_BLOCKED_REASON =
  "Codex workers are turned off for this agent (Agent → Tools in the UI). Tell the user; do not try to run Codex another way.";

export const CLAUDE_BLOCKED_REASON =
  "Claude Code workers are turned off for this agent (Agent → Tools in the UI). Tell the user; do not try to run Claude Code another way.";

export function renderAgentPolicyMod(options: {
  codexBlocked: readonly string[];
  claudeBlocked?: readonly string[];
}): string {
  const header = `// letta-ui agent-policy v2 — rendered by the lettuce BFF (bff/src/codex/policy-mod.ts).
// Edits here are overwritten on the BFF's next connect.`;
  const codex = [...options.codexBlocked].sort();
  const claude = [...(options.claudeBlocked ?? [])].sort();
  if (codex.length === 0 && claude.length === 0) {
    // The protocol cannot delete a file, so "nothing blocked" registers nothing.
    return `${header}
// No agent is blocked from anything: registers nothing.
export default function activate() {}
`;
  }
  return `${header}
const CODEX_BLOCKED = new Set(${JSON.stringify(codex)});
const CLAUDE_BLOCKED = new Set(${JSON.stringify(claude)});
const CODEX_REASON = ${JSON.stringify(CODEX_BLOCKED_REASON)};
const CLAUDE_REASON = ${JSON.stringify(CLAUDE_BLOCKED_REASON)};

function startsCodex(args) {
  if (args.subagent_type === "codex") return true;
  return typeof args.agent_id === "string" && args.agent_id.startsWith("codex_");
}

function startsClaude(args) {
  if (args.subagent_type === "claude-code") return true;
  return typeof args.agent_id === "string" && args.agent_id.startsWith("claude_");
}

export default function activate(letta) {
  if (!letta.capabilities?.permissions) return;
  return letta.permissions.register({
    id: "letta-ui-external-workers-per-agent",
    description: "Codex and Claude Code workers blocked per agent (Agent → Tools)",
    check(event) {
      const args = event.args ?? {};
      if (event.agentId && CODEX_BLOCKED.has(event.agentId) && startsCodex(args)) {
        return { decision: "deny", reason: CODEX_REASON };
      }
      if (event.agentId && CLAUDE_BLOCKED.has(event.agentId) && startsClaude(args)) {
        return { decision: "deny", reason: CLAUDE_REASON };
      }
      return undefined;
    },
  });
}
`;
}
