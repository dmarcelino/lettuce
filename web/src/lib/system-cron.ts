/**
 * Unix cron jobs an agent set up for commands that need no agent, listed
 * read-only in the Tasks tab. The BFF reads and filters them
 * (`bff/src/system-cron.ts`): this agent's jobs plus those with no owner.
 */

export interface SystemCronJob {
  name: string;
  /** null: no `# agent:` line, so the job shows under every agent. */
  agentId: string | null;
  description: string | null;
  entries: { schedule: string; command: string }[];
  /** false: saved, but cron runs it (or this version of it) only after a restart. */
  live: boolean;
}

export interface SystemCronList {
  /** The container's timezone, which cron schedules run in. */
  timezone: string;
  jobs: SystemCronJob[];
}

export async function fetchSystemCron(agentId: string): Promise<SystemCronList> {
  const response = await fetch(`/api/agents/system-cron/${encodeURIComponent(agentId)}`);
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return (await response.json()) as SystemCronList;
}

/**
 * The start of a message asking the agent to change a job: only an agent can, and
 * "cron job" is the phrase that has it load the skill saying how.
 */
export function askToChangeText(job: Pick<SystemCronJob, "name">): string {
  return `Change the cron job "${job.name}": `;
}
