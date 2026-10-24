/**
 * The link between a running Monitor and its armed backup wake.
 *
 * Upstream arms the backup as an ordinary one-shot cron task (letta-code
 * `tools/impl/monitor-backup.ts` → the `Wake` tool) whose name is the monitor's
 * description behind a fixed prefix — the process summary on the wire carries
 * no wake id, so the name is the only join. `shortcut:` two monitors sharing a
 * description both match, and a hand-made task of the same name false-positives;
 * both are cosmetic. Upgrade if upstream ever puts the wake id on the wire.
 */

/** Mirrors upstream `wakeName()`: prefix plus description, 80 chars with an ellipsis. */
export function monitorBackupWakeName(description: string): string {
  const name = `Monitor backup: ${description}`;
  return name.length > 80 ? `${name.slice(0, 79)}…` : name;
}

interface BackupWakeCandidate {
  name: string;
  recurring: boolean;
  status: string;
  scheduled_for: string | null;
}

/** The armed backup wake for a running monitor, or null. Fired and paused tasks do not count. */
export function findMonitorBackupWake<T extends BackupWakeCandidate>(
  monitorDescription: string,
  tasks: readonly T[],
): T | null {
  const name = monitorBackupWakeName(monitorDescription);
  return (
    tasks.find(
      (task) =>
        task.name === name &&
        !task.recurring &&
        task.status === "active" &&
        task.scheduled_for !== null,
    ) ?? null
  );
}
