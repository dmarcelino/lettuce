/**
 * Settings → Skills. The list comes from the BFF (`GET /api/skills`), which
 * walks the skill roots itself: upstream only publishes the list on a live
 * conversation runtime, which is evicted between turns.
 */

export type SkillSource = "bundled" | "global" | "agent" | "project";

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  path: string;
  source: SkillSource;
  /** Lower-priority scopes this skill hides a same-id skill in. */
  overrides?: SkillSource[];
  /** A global skill's symlink name — what `skill_disable` takes. Absent: not disableable. */
  link?: string;
  /** Set when the BFF reinstalls this skill itself, so a Disable would not stick. */
  managedBy?: string;
}

export interface SkillList {
  skills: SkillSummary[];
  errors: { path: string; message: string }[];
}

export async function fetchSkills(agentId: string, cwd: string | null): Promise<SkillList> {
  const params = new URLSearchParams({ agent_id: agentId });
  if (cwd) params.set("cwd", cwd);
  const response = await fetch(`/api/skills?${params}`);
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response.json();
}

/** Highest priority first — the order a reader resolves a name conflict in. */
export const SKILL_SCOPES: { source: SkillSource; label: string; hint: string }[] = [
  { source: "project", label: "Project", hint: "this agent's working directory" },
  { source: "agent", label: "Agent", hint: "this agent's memory" },
  { source: "global", label: "Global", hint: "every agent" },
  { source: "bundled", label: "Bundled", hint: "ship with letta-code" },
];

export function groupSkills(
  skills: readonly SkillSummary[],
): { source: SkillSource; label: string; hint: string; skills: SkillSummary[] }[] {
  return SKILL_SCOPES.map((scope) => ({
    ...scope,
    skills: skills.filter((skill) => skill.source === scope.source),
  })).filter((group) => group.skills.length > 0);
}

/** "3 global · 20 bundled" — highest-priority scope first. */
export function summarizeSkills(skills: readonly SkillSummary[]): string {
  if (skills.length === 0) return "No skills";
  return groupSkills(skills)
    .map((group) => `${group.skills.length} ${group.label.toLowerCase()}`)
    .join(" · ");
}

/** The directory a skill lives in — what `skill_disable` and a reader care about. */
export function skillDir(path: string): string {
  return path.replace(/\/SKILL\.md$/i, "");
}
