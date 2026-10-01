/**
 * Every skill an agent can load, computed by the BFF rather than asked for.
 *
 * Upstream has no command that lists skills. The only list it publishes is
 * `device_status.current_available_skills`, filled in `turn-setup.ts` on the
 * conversation runtime — which is evicted between turns, after which the
 * status carries `[]`. So Settings → Skills showed skills only while a turn
 * ran. This walks the same roots with the same rules instead
 * (`src/agent/skills.ts` `discoverSkills`, `src/agent/client-skills.ts`
 * `collectClientSideSkills`), and `sync-upstream.sh` flags both files so a
 * change to the rules is noticed.
 *
 * Roots, lowest priority first, each overriding the last by skill id:
 *   bundled  in the app-server image — read over the upstream connection
 *   global   /root/.letta/skills
 *   agent    /root/.letta/agents/<id>/memory/skills
 *   project  <cwd>/.skills (legacy), then <cwd>/.agents/skills
 * and finally the agent's memfs `skills/`, reported as `agent`, which fills
 * in or overrides bundled and global but never project or agent.
 *
 * The host roots are read from the BFF's own read-only mounts, at the same
 * absolute paths as in the app-server. Not over the protocol: its
 * `list_in_directory` and `get_tree` skip symlinks, and every skill added
 * with `skill_enable` IS a symlink.
 */

import { frontmatterBoolean, frontmatterString, parseFrontmatter } from "./frontmatter.ts";

export type SkillSource = "bundled" | "global" | "agent" | "project";

export interface DiscoveredSkill {
  id: string;
  name: string;
  description: string;
  /** SKILL.md's path, as the app-server would report it. */
  path: string;
  source: SkillSource;
  /** Lower-priority scopes that had a skill with the same id, now hidden by this one. */
  overrides?: SkillSource[];
  /**
   * For a global skill that is a symlink in /root/.letta/skills: the link's
   * name, which is what `skill_disable` takes. `skill_disable` refuses a real
   * directory, so a skill without this cannot be disabled from the UI.
   */
  link?: string;
  /** Set when the BFF itself installs this skill, so a manual change would not stick. */
  managedBy?: string;
}

export interface SkillDiscoveryError {
  path: string;
  message: string;
}

export interface SkillEntry {
  name: string;
  kind: "dir" | "file";
  /** True when the entry is a symlink (and `kind` is its target's). */
  linked?: boolean;
}

/** File access for one set of roots. Symlinks must already be resolved to their target's kind. */
export interface SkillFs {
  /** Entries in `dir`, or null when it does not exist. */
  list(dir: string): Promise<SkillEntry[] | null>;
  read(path: string): Promise<string>;
  /** Canonical path, for the loop guard. */
  realpath(path: string): Promise<string>;
}

export const GLOBAL_SKILLS_DIR = "/root/.letta/skills";
export const BUNDLED_SKILLS_DIR =
  process.env.LETTA_BUNDLED_SKILLS_DIR ?? "/usr/local/lib/node_modules/@letta-ai/letta-code/skills";
const AGENTS_DIR = "/root/.letta/agents";
const MEMFS_DIR = "/data/local-backend/memfs";

/** Bundled skills upstream hides from local agents (`LOCAL_AGENT_EXCLUDED_BUNDLED_SKILLS`). */
const LOCAL_AGENT_EXCLUDED_BUNDLED = new Set([
  "curating-memory-palace",
  "image-generation",
  "managing-shared-memory",
  "working-across-computers",
]);

interface ParsedSkill extends DiscoveredSkill {
  disableModelInvocation: boolean;
}

/** One SKILL.md, read the way `parseSkillFile` reads it. */
export function parseSkill(
  content: string,
  filePath: string,
  root: string,
  source: SkillSource,
): ParsedSkill {
  const { frontmatter, body } = parseFrontmatter(content);
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  const relative = filePath.slice(normalizedRoot.length + 1);
  const defaultId = relative.slice(0, -"/SKILL.MD".length) || "root";

  const frontmatterName = frontmatterString(frontmatter, "name");
  const id = frontmatterString(frontmatter, "id") || frontmatterName || defaultId;
  const name =
    frontmatterName ||
    (typeof frontmatter.title === "string" ? frontmatter.title : null) ||
    (id.split("/").pop() ?? "").replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());

  let description = frontmatterString(frontmatter, "description") ?? null;
  if (!description) description = body.trim().split("\n\n")[0] || "No description available";
  description = description.trim();
  const whenToUse = frontmatterString(frontmatter, "when_to_use")?.trim();

  return {
    id,
    name,
    description: whenToUse ? `${description}\n\nWhen to use: ${whenToUse}` : description,
    path: filePath,
    source,
    disableModelInvocation: frontmatterBoolean(frontmatter, "disable-model-invocation") ?? false,
  };
}

/** Recursive SKILL.md search under `root`, following symlinks once each (`findSkillFiles`). */
export async function discoverDir(
  fs: SkillFs,
  root: string,
  source: SkillSource,
): Promise<{ skills: ParsedSkill[]; errors: SkillDiscoveryError[] }> {
  const skills: ParsedSkill[] = [];
  const errors: SkillDiscoveryError[] = [];
  const visited = new Set<string>();
  const rootDir = root.endsWith("/") ? root.slice(0, -1) : root;

  const walk = async (dir: string, link: string | undefined): Promise<void> => {
    let entries: SkillEntry[] | null;
    try {
      const real = await fs.realpath(dir);
      if (visited.has(real)) return;
      visited.add(real);
      entries = await fs.list(dir);
    } catch (error) {
      // A missing root is simply an empty scope, exactly as upstream treats it.
      if (dir === root && isMissing(error)) return;
      errors.push({ path: dir, message: messageOf(error) });
      return;
    }
    if (!entries) return;

    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.kind === "dir") {
        // Only a link directly in the root is something skill_disable can remove.
        await walk(full, link ?? (dir === rootDir && entry.linked ? entry.name : undefined));
      } else if (entry.name.toUpperCase() === "SKILL.MD") {
        try {
          const skill = parseSkill(await fs.read(full), full, root, source);
          skills.push(link ? { ...skill, link } : skill);
        } catch (error) {
          errors.push({ path: full, message: messageOf(error) });
        }
      }
    }
  };

  await walk(rootDir, undefined);
  return { skills, errors };
}

export interface DiscoverOptions {
  agentId: string;
  /** The conversation's working directory, where project skills live. */
  cwd: string;
  /** Host roots (global, agent, project, memfs). */
  hostFs: SkillFs;
  /** Bundled skills, already discovered — they live in the app-server image. */
  bundled: { skills: DiscoveredSkill[]; errors: SkillDiscoveryError[] };
}

export async function discoverSkills(
  options: DiscoverOptions,
): Promise<{ skills: DiscoveredSkill[]; errors: SkillDiscoveryError[] }> {
  const { agentId, cwd, hostFs } = options;
  const errors: SkillDiscoveryError[] = [...options.bundled.errors];
  const byId = new Map<string, ParsedSkill>();

  const put = (skill: ParsedSkill) => {
    const existing = byId.get(skill.id);
    if (existing) {
      const overrides = new Set([...(existing.overrides ?? []), existing.source]);
      overrides.delete(skill.source);
      if (overrides.size > 0) skill = { ...skill, overrides: [...overrides] };
    }
    byId.set(skill.id, skill);
  };

  for (const skill of options.bundled.skills) {
    put({ ...skill, disableModelInvocation: false });
  }

  const runs: Array<[string, SkillSource]> = [
    [GLOBAL_SKILLS_DIR, "global"],
    [`${AGENTS_DIR}/${agentId}/memory/skills`, "agent"],
    [`${cwd}/.skills`, "project"],
    [`${cwd}/.agents/skills`, "project"],
  ];
  for (const [root, source] of runs) {
    const result = await discoverDir(hostFs, root, source);
    errors.push(...result.errors);
    for (const skill of sortSkills(result.skills)) put(skill);
  }

  // Memory skills are discovered last and never displace project or agent ones.
  const memory = await discoverDir(hostFs, `${MEMFS_DIR}/${agentId}/memory/skills`, "agent");
  errors.push(...memory.errors);
  const seen = new Set<string>();
  for (const skill of sortSkills(memory.skills)) {
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    const existing = byId.get(skill.id);
    if (existing?.source === "project" || existing?.source === "agent") continue;
    put(skill);
  }

  // Upstream filters the merged map with `isSkillAvailableForAgent`, not the
  // bundled root: a local agent's own copy of a Cloud-only skill survives.
  const local = agentId.startsWith("agent-local-");
  const skills = sortSkills([...byId.values()])
    .filter((skill) => !skill.disableModelInvocation)
    .filter(
      (skill) =>
        !(local && skill.source === "bundled" && LOCAL_AGENT_EXCLUDED_BUNDLED.has(skill.id)),
    )
    .map(({ disableModelInvocation: _, ...skill }) => skill);
  return { skills, errors };
}

/** Bundled skills for the cache: parsed, filtered, stripped of the private flag. */
export async function discoverBundled(
  fs: SkillFs,
  root: string = BUNDLED_SKILLS_DIR,
): Promise<{ skills: DiscoveredSkill[]; errors: SkillDiscoveryError[] }> {
  const result = await discoverDir(fs, root, "bundled");
  return {
    skills: sortSkills(result.skills)
      .filter((skill) => !skill.disableModelInvocation)
      .map(({ disableModelInvocation: _, ...skill }) => skill),
    errors: result.errors,
  };
}

function sortSkills<T extends DiscoveredSkill>(skills: T[]): T[] {
  return [...skills].sort(
    (a, b) =>
      a.id.localeCompare(b.id) || a.source.localeCompare(b.source) || a.path.localeCompare(b.path),
  );
}

function isMissing(error: unknown): boolean {
  return /ENOENT|ENOTDIR|no such file/i.test(messageOf(error));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
