/** How long a looked-up name is trusted; a rename shows up within this. */
export const AGENT_NAME_TTL_MS = 10 * 60_000;

/**
 * Agent display names for push titles, looked up through the upstream
 * connection and cached. A push is never held up or lost over a name: a failed
 * lookup answers null and the caller falls back to a generic title.
 */
export class AgentNames {
  private readonly cache = new Map<string, { name: string; at: number }>();

  constructor(
    private readonly lookup: (agentId: string) => Promise<string | null>,
    private readonly now: () => number = Date.now,
  ) {}

  async name(agentId: string): Promise<string | null> {
    const cached = this.cache.get(agentId);
    if (cached && this.now() - cached.at < AGENT_NAME_TTL_MS) return cached.name;
    try {
      const name = (await this.lookup(agentId))?.trim();
      if (!name) return cached?.name ?? null;
      this.cache.set(agentId, { name, at: this.now() });
      return name;
    } catch {
      // A stale name beats none.
      return cached?.name ?? null;
    }
  }
}
