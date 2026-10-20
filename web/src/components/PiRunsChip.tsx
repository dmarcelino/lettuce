import { useEffect, useState } from "react";
import { fetchPiRuns, type PiRunSummary } from "../lib/pi.ts";
import { msSinceLastPiFrame, stalenessWatchdogMs, usePiLiveRuns } from "../lib/pi-live.ts";

/**
 * How many remote-pi runs are currently running — derived from the pushed
 * progress frames, so an idle page issues zero pi requests (this replaced a
 * 60-s-forever poll). One fetch on mount covers runs that started before the
 * page did; the watchdog re-syncs if the frame stream stalls (a BFF restart
 * mid-run settles every orphan at once, with no socket listening). Feeds both
 * the Runs tab dot and the topbar chip.
 */
export function usePiActiveRuns(enabled: boolean): number {
  const [fetched, setFetched] = useState<PiRunSummary[]>([]);
  const live = usePiLiveRuns();

  useEffect(() => {
    if (!enabled) {
      setFetched([]);
      return;
    }
    void fetchPiRuns(10)
      .then(setFetched)
      .catch(() => {
        /* the section 404s when the `pi` token is off; zero is the answer */
      });
  }, [enabled]);

  const running = new Set(
    [
      ...fetched.map((run) => ({ runId: run.runId, running: run.status === "running" })),
      ...Object.values(live).map((fact) => ({
        runId: fact.runId,
        running: fact.state === "running",
      })),
    ]
      .filter((run) => run.running)
      .map((run) => run.runId),
  );
  const active = enabled ? running.size : 0;

  useEffect(() => {
    if (!enabled || running.size === 0) return;
    const timer = setInterval(() => {
      if (msSinceLastPiFrame() > stalenessWatchdogMs) {
        void fetchPiRuns(10)
          .then(setFetched)
          .catch(() => {
            /* the next tick tries again */
          });
      }
    }, 5_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- size is the signal
  }, [enabled, running.size]);

  return active;
}

/** Compact topbar chip: "pi · N" while runs are active. */
export function PiRunsChip({ active, onOpen }: { active: number; onOpen: () => void }) {
  if (active <= 0) return null;
  return (
    <button
      type="button"
      className="chip pi-chip"
      onClick={onOpen}
      title={`${active} remote pi run${active === 1 ? "" : "s"} running`}
    >
      <i className="tab-dot" aria-hidden="true" />
      pi · {active}
    </button>
  );
}
