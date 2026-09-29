import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_BLOCKED_REASON, renderAgentPolicyMod } from "./policy-mod.ts";

interface Registered {
  id: string;
  check: (event: Record<string, unknown>) => unknown;
}

/** Loads the rendered mod and runs its `activate` against a fake `letta`. */
async function activate(source: string): Promise<Registered[]> {
  const file = join(mkdtempSync(join(tmpdir(), "policy-mod-")), "mod.mjs");
  writeFileSync(file, source);
  const mod = (await import(file)) as { default: (letta: unknown) => unknown };
  const registered: Registered[] = [];
  mod.default({
    capabilities: { permissions: true },
    permissions: {
      register(permission: Registered) {
        registered.push(permission);
        return () => {};
      },
    },
  });
  return registered;
}

describe("the agent-policy mod", () => {
  test("nothing blocked registers nothing", async () => {
    expect(await activate(renderAgentPolicyMod({ codexBlocked: [] }))).toEqual([]);
  });

  test("a blocked agent cannot start or message a Codex worker", async () => {
    const [permission] = await activate(renderAgentPolicyMod({ codexBlocked: ["agent-b"] }));
    const check = (agentId: string | null, toolName: string, args: Record<string, unknown>) =>
      permission?.check({ agentId, toolName, args });
    const deny = { decision: "deny", reason: CODEX_BLOCKED_REASON };

    expect(check("agent-b", "Task", { subagent_type: "codex", prompt: "x" })).toEqual(deny);
    expect(check("agent-b", "Agent", { subagent_type: "codex" })).toEqual(deny);
    expect(
      check("agent-b", "SendAgentMessage", {
        agent_id: "codex_0199aa00-0000-7000-8000-000000000000",
      }),
    ).toEqual(deny);
    // Everything else, and every other agent, is left to the normal rules.
    expect(check("agent-b", "Task", { subagent_type: "general-purpose" })).toBeUndefined();
    expect(check("agent-b", "SendAgentMessage", { agent_id: "agent-c" })).toBeUndefined();
    expect(check("agent-b", "Bash", { command: "ls" })).toBeUndefined();
    expect(check("agent-a", "Task", { subagent_type: "codex" })).toBeUndefined();
    expect(check(null, "Task", { subagent_type: "codex" })).toBeUndefined();
  });
});
