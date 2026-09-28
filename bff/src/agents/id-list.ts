import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * A list of agent ids the BFF keeps for the UI — which agents are pinned
 * (listed first, in pin order) and which are archived (hidden until asked
 * for). Ours, not upstream's: letta-code keeps a pinned list in
 * `settings.json` for its CLI picker but the protocol only sets it at creation
 * (`create_agent.pin_global`), and it has no archive at all — its agent
 * `hidden` flag is what marks subagents. Kept by the BFF rather than the
 * browser so a phone and a laptop agree. Preferences, not state anything
 * depends on: a lost file only unpins or unarchives everything.
 */
export class AgentIdList {
  private ids: string[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly onWriteError: (error: unknown) => void,
  ) {
    if (!existsSync(filePath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (Array.isArray(parsed)) {
        this.ids = [...new Set(parsed.filter((id): id is string => isAgentId(id)))];
      }
    } catch {
      // Unreadable: start with nothing pinned rather than fail to boot.
    }
  }

  list(): string[] {
    return [...this.ids];
  }

  /** Add (appended, so order is kept) or remove. Returns the new list. */
  set(agentId: string, present: boolean): string[] {
    if (!isAgentId(agentId)) throw new Error("Not an agent id");
    const without = this.ids.filter((id) => id !== agentId);
    const next = present ? [...without, agentId] : without;
    if (next.length !== this.ids.length || next.some((id, i) => id !== this.ids[i])) {
      this.ids = next;
      this.persist();
    }
    return this.list();
  }

  /** Resolves once every queued write has settled; never rejects. */
  drain(): Promise<void> {
    return this.writeQueue;
  }

  private persist(): void {
    const snapshot = JSON.stringify(this.ids, null, 2);
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => {
        try {
          const temp = `${this.filePath}.tmp`;
          writeFileSync(temp, snapshot);
          renameSync(temp, this.filePath);
        } catch (error) {
          this.onWriteError(error);
        }
      });
  }
}

export function isAgentId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\s/]/.test(value)
  );
}
