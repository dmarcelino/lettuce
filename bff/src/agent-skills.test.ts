import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAgentSkills, readSkillTree } from "./agent-skills.ts";

const root = mkdtempSync(join(tmpdir(), "agent-skills-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(join(root, "serving-web-apps", "scripts"), { recursive: true });
writeFileSync(join(root, "serving-web-apps", "SKILL.md"), "---\nname: serving-web-apps\n---\n");
writeFileSync(join(root, "serving-web-apps", "scripts", "free-port.sh"), "echo 3000\n");
mkdirSync(join(root, "not-a-skill"));
writeFileSync(join(root, "not-a-skill", "notes.md"), "ignored");
writeFileSync(join(root, "README.md"), "ignored");

describe("readSkillTree", () => {
  test("every file of every directory that has a SKILL.md, and nothing else", () => {
    expect(readSkillTree(root).map((f) => f.path)).toEqual([
      "serving-web-apps/SKILL.md",
      "serving-web-apps/scripts/free-port.sh",
    ]);
  });

  test("a missing root is no skills, not a crash", () => {
    expect(readSkillTree(join(root, "absent"))).toEqual([]);
  });
});

describe("installAgentSkills", () => {
  test("writes each file under the global skills directory", async () => {
    const write = mock(async (_path: string, _content: string) => {});
    const count = await installAgentSkills(readSkillTree(root), write, () => {});
    expect(count).toBe(2);
    expect(write.mock.calls.map((c) => c[0])).toEqual([
      "/root/.letta/skills/serving-web-apps/SKILL.md",
      "/root/.letta/skills/serving-web-apps/scripts/free-port.sh",
    ]);
  });

  test("one failed write is logged and does not stop the rest", async () => {
    const logs: string[] = [];
    let first = true;
    const count = await installAgentSkills(
      readSkillTree(root),
      async () => {
        if (first) {
          first = false;
          throw new Error("app-server down");
        }
      },
      (m) => logs.push(m),
    );
    expect(count).toBe(1);
    expect(logs.some((m) => m.includes("not installed: app-server down"))).toBe(true);
  });
});
