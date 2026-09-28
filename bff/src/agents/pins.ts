import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Pinned agents: listed first in the switcher and the sidebar, in the order
 * they were pinned. Ours, not upstream's — letta-code keeps a pinned list in
 * `settings.json` for its CLI picker, but the protocol can only set it when an
 * agent is created (`pin_global`), never for an existing one. Kept by the BFF
 * rather than the browser so a phone and a laptop agree. A preference, not
 * state anything depends on: a lost file only unpins everything.
 */
export class AgentPinStore {
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

  /** Pin (appended, so pin order is kept) or unpin. Returns the new list. */
  set(agentId: string, pinned: boolean): string[] {
    if (!isAgentId(agentId)) throw new Error("Not an agent id");
    const without = this.ids.filter((id) => id !== agentId);
    const next = pinned ? [...without, agentId] : without;
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
