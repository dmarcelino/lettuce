import { posix } from "node:path";
import {
  type DiscoveredSkill,
  discoverBundled,
  discoverSkills,
  GLOBAL_SKILLS_DIR,
  type SkillDiscoveryError,
  type SkillFs,
} from "./discovery.ts";

const WORKSPACE_ROOT = "/work";

export class InvalidSkillScopeError extends Error {}

/**
 * `GET /api/skills` — every skill one agent can load right now, turn or no turn.
 *
 * Bundled skills change only with the app-server version, and reading them
 * costs a protocol round trip per file, so they are cached until the upstream
 * reconnects (`reset`). Everything else is re-read on each call: it is a
 * handful of directories, and a cache would only reintroduce the staleness
 * this exists to remove.
 */
export class SkillCatalog {
  private bundled: Promise<{ skills: DiscoveredSkill[]; errors: SkillDiscoveryError[] }> | null =
    null;

  constructor(
    private readonly hostFs: SkillFs,
    private readonly bundledFs: SkillFs,
    /**
     * Global skill directories the BFF itself (re)installs on every connect,
     * by name → where to change them instead. A Disable there would not stick.
     */
    private readonly managed: () => ReadonlyMap<string, string> = () => new Map(),
  ) {}

  reset(): void {
    this.bundled = null;
  }

  async list(
    agentId: string,
    cwd?: string | null,
  ): Promise<{ skills: DiscoveredSkill[]; errors: SkillDiscoveryError[] }> {
    if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new InvalidSkillScopeError("Invalid agent_id");
    const workingDirectory = cwd ? posix.normalize(cwd) : `${WORKSPACE_ROOT}/${agentId}`;
    if (!workingDirectory.startsWith(`${WORKSPACE_ROOT}/`) && workingDirectory !== WORKSPACE_ROOT) {
      throw new InvalidSkillScopeError(`cwd must be inside ${WORKSPACE_ROOT}`);
    }

    if (!this.bundled) {
      const pending = discoverBundled(this.bundledFs);
      this.bundled = pending;
      // A failed read must not be cached for the life of the connection.
      pending.catch(() => {
        if (this.bundled === pending) this.bundled = null;
      });
    }
    const bundled = await this.bundled;
    const result = await discoverSkills({
      agentId,
      cwd: workingDirectory,
      hostFs: this.hostFs,
      bundled,
    });
    const managed = this.managed();
    const skills = result.skills.map((skill) => {
      if (skill.source !== "global") return skill;
      const dir = skill.path.slice(GLOBAL_SKILLS_DIR.length + 1).split("/")[0] ?? "";
      const managedBy = managed.get(dir);
      return managedBy ? { ...skill, managedBy } : skill;
    });
    return { skills, errors: result.errors };
  }
}
