import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type DiscoveredSkill,
  discoverBundled,
  discoverSkills,
  type SkillFs,
} from "./discovery.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { hostSkillFs, upstreamSkillFs } from "./fs.ts";

const base = mkdtempSync(join(tmpdir(), "skills-discovery-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

/**
 * Discovery uses the app-server's absolute paths (/root/.letta, /data, /work).
 * Tests map them under a temp dir, so the walker sees the same strings it
 * would in the container.
 */
function rooted(fs: SkillFs): SkillFs {
  const map = (path: string) => join(base, path);
  return {
    list: (dir) => fs.list(map(dir)),
    read: (path) => fs.read(map(path)),
    realpath: (path) => fs.realpath(map(path)),
  };
}
const hostFs = rooted(hostSkillFs);

function skill(path: string, frontmatter: string, body = ""): void {
  const full = join(base, path, "SKILL.md");
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `---\n${frontmatter}\n---\n${body}`);
}

const AGENT = "agent-local-abc";
const CWD = `/work/${AGENT}`;
const noBundled = { skills: [], errors: [] };
const bundledSkill = (id: string): DiscoveredSkill => ({
  id,
  name: id,
  description: `bundled ${id}`,
  path: `/bundled/${id}/SKILL.md`,
  source: "bundled",
});

skill("root/.letta/skills/web-apps", "name: web-apps\ndescription: Serve apps");
skill("root/.letta/skills/hidden", "name: hidden\ndescription: x\ndisable-model-invocation: true");
skill("elsewhere/linked", "name: linked\ndescription: Enabled with skill_enable");
symlinkSync(join(base, "elsewhere/linked"), join(base, "root/.letta/skills/linked"));
// A link back to its own parent must not loop forever.
symlinkSync(join(base, "root/.letta/skills"), join(base, "root/.letta/skills/web-apps/loop"));
skill(`root/.letta/agents/${AGENT}/memory/skills/shared`, "name: shared\ndescription: agent copy");
skill("root/.letta/skills/shared", "name: shared\ndescription: global copy");
skill(`work/${AGENT}/.agents/skills/proj`, "name: proj", "First paragraph.\n\nSecond.");
skill(`work/${AGENT}/.skills/proj`, "name: proj\ndescription: legacy");
skill(`data/local-backend/memfs/${AGENT}/memory/skills/mem`, "name: mem\ndescription: in memfs");
skill(`data/local-backend/memfs/${AGENT}/memory/skills/proj`, "name: proj\ndescription: memfs");
skill(`data/local-backend/memfs/${AGENT}/memory/skills/web-apps`, "name: web-apps\ndescription: m");

const result = await discoverSkills({
  agentId: AGENT,
  cwd: CWD,
  hostFs,
  bundled: { skills: [bundledSkill("image-generation"), bundledSkill("proj")], errors: [] },
});
const byId = new Map(result.skills.map((s) => [s.id, s]));

describe("discoverSkills", () => {
  test("a skill_enable symlink is followed, and named for skill_disable", () => {
    expect(byId.get("linked")).toMatchObject({ source: "global", link: "linked" });
  });

  test("a real directory in the global root carries no link — skill_disable refuses those", async () => {
    const globalOnly = await discoverSkills({
      agentId: "agent-local-other",
      cwd: "/work/other",
      hostFs,
      bundled: noBundled,
    });
    const shared = globalOnly.skills.find((s) => s.id === "shared");
    expect(shared?.source).toBe("global");
    expect(shared?.link).toBeUndefined();
  });

  test("disable-model-invocation skills are not listed", () => {
    expect(byId.has("hidden")).toBe(false);
  });

  test("bundled skills upstream hides from local agents are hidden", () => {
    expect(byId.has("image-generation")).toBe(false);
  });

  test("agent scope overrides global, and says so", () => {
    expect(byId.get("shared")).toMatchObject({
      source: "agent",
      description: "agent copy",
      overrides: ["global"],
    });
  });

  test(".agents/skills wins over legacy .skills, and memfs never displaces project", () => {
    const proj = byId.get("proj");
    expect(proj?.path).toBe(`${CWD}/.agents/skills/proj/SKILL.md`);
    expect(proj?.description).toBe("First paragraph.");
    expect(proj?.overrides).toEqual(["bundled"]);
  });

  test("memfs skills are reported as agent and override global", () => {
    expect(byId.get("mem")?.source).toBe("agent");
    expect(byId.get("web-apps")).toMatchObject({ source: "agent", overrides: ["global"] });
  });

  test("missing roots are empty scopes, not errors", async () => {
    const empty = await discoverSkills({
      agentId: "agent-local-none",
      cwd: "/work/nowhere",
      hostFs: rooted(hostSkillFs),
      bundled: noBundled,
    });
    expect(empty.errors).toEqual([]);
  });

  test("sorted by id", () => {
    const ids = result.skills.map((s) => s.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });
});

describe("discoverBundled", () => {
  test("walks the protocol listing and reads each SKILL.md", async () => {
    const files: Record<string, string> = {
      "/b/one/SKILL.md": "---\nname: one\ndescription: first\nwhen_to_use: often\n---\n",
      "/b/nested/two/SKILL.md": "---\nname: two\ndescription: second\n---\n",
    };
    const fs = upstreamSkillFs({
      async list(dir) {
        const prefix = `${dir}/`;
        const children = Object.keys(files)
          .filter((p) => p.startsWith(prefix))
          .map((p) => p.slice(prefix.length).split("/"));
        const folders = [...new Set(children.filter((c) => c.length > 1).map((c) => c[0] ?? ""))];
        const names = children.filter((c) => c.length === 1).map((c) => c[0] ?? "");
        return children.length ? { folders, files: names } : null;
      },
      read: async (path) => files[path] ?? "",
    });
    const bundled = await discoverBundled(fs, "/b");
    expect(bundled.skills.map((s) => [s.id, s.description])).toEqual([
      ["one", "first\n\nWhen to use: often"],
      ["two", "second"],
    ]);
  });
});

describe("parseFrontmatter", () => {
  test("folded block scalars and quoted values read as upstream reads them", () => {
    const { frontmatter } = parseFrontmatter(
      '---\nname: "quoted"\ndescription: >\n  one\n  two\ntags:\n  - a\n  - b\n---\nbody',
    );
    expect(frontmatter.description).toBe("one two\n");
    expect(frontmatter.tags).toEqual(["a", "b"]);
    expect(frontmatter.name).toBe('"quoted"');
  });
});
