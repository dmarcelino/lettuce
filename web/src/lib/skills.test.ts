import { describe, expect, test } from "bun:test";
import { groupSkills, type SkillSummary, skillDir, summarizeSkills } from "./skills.ts";

const make = (id: string, source: SkillSummary["source"]): SkillSummary => ({
  id,
  name: id,
  description: "",
  path: `/x/${id}/SKILL.md`,
  source,
});

const skills = [
  make("a", "bundled"),
  make("b", "global"),
  make("c", "bundled"),
  make("d", "project"),
];

describe("groupSkills", () => {
  test("highest-priority scope first, empty scopes dropped", () => {
    expect(groupSkills(skills).map((g) => [g.source, g.skills.map((s) => s.id)])).toEqual([
      ["project", ["d"]],
      ["global", ["b"]],
      ["bundled", ["a", "c"]],
    ]);
  });
});

describe("summarizeSkills", () => {
  test("counts per scope", () => {
    expect(summarizeSkills(skills)).toBe("1 project · 1 global · 2 bundled");
  });
  test("empty", () => {
    expect(summarizeSkills([])).toBe("No skills");
  });
});

test("skillDir strips SKILL.md whatever its case", () => {
  expect(skillDir("/root/.letta/skills/x/SKILL.MD")).toBe("/root/.letta/skills/x");
});
