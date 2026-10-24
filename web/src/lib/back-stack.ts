/**
 * The phone's Back button closes the top modal, not the app.
 *
 * Every open overlay owns one browser-history entry. Back pops it (popstate)
 * and the top overlay closes. An overlay closed on screen instead leaves its
 * entry behind; that "stale" entry is removed with a deferred `history.back()`
 * whose popstate is ignored — deferred, because an overlay often replaces
 * another in the same render ("New agent" closes the switcher and opens the
 * agent editor), and the new one simply takes over the stale entry.
 *
 * An overlay whose close returns `false` cannot be dismissed (an approval
 * prompt): Back is swallowed and its entry re-pushed, so the app neither
 * closes the prompt nor exits underneath it.
 */
export interface HistoryLike {
  pushState(data: unknown, unused: string): void;
  back(): void;
}

/** A truthy return tells the stack the Back press was used. `void` stays in the
 * union because callers hand over state setters — `() => setMenuFor(null)` —
 * which return nothing, and dropping it would refuse them at the call site. */
// biome-ignore lint/suspicious/noConfusingVoidType: void is what accepts `() => setMenuFor(null)` as a close handler; boolean | undefined alone refuses it.
export type Close = () => boolean | void;

const MARKER = { lettaOverlay: true };

/** An open overlay, and what orders it against the others open at the same time. */
interface Entry {
  close: Close;
  rank: number;
}

export class BackStack {
  private readonly entries: Entry[] = [];
  /** History entries whose overlay was closed on screen, not yet removed. */
  private stale = 0;
  /** popstate events this class caused itself. */
  private ignore = 0;

  constructor(
    private readonly history: HistoryLike,
    private readonly defer: (fn: () => void) => void = (fn) => setTimeout(fn, 0),
  ) {}

  get depth(): number {
    return this.entries.length;
  }

  /** Insert keeping ascending rank, stable for ties (open order breaks a tie). */
  private insert(entry: Entry): void {
    let index = this.entries.length;
    while (index > 0 && (this.entries[index - 1]?.rank ?? Number.NEGATIVE_INFINITY) > entry.rank) {
      index -= 1;
    }
    this.entries.splice(index, 0, entry);
  }

  /**
   * Register an open overlay; the returned function is called when it goes away.
   *
   * `rank` orders overlays that are open at the same time. A sheet rendered
   * inside another sheet (a picker over a form) mounts as a descendant, so React
   * runs its effect first and registration order alone would put the OUTER one on
   * top — Back would close the form and drop its unsaved draft. Entries are kept
   * in ascending rank, stable for ties, and Back closes the last: the innermost.
   */
  open(close: Close, rank = 0): () => void {
    const entry: Entry = { close, rank };
    this.insert(entry);
    if (this.stale > 0) this.stale -= 1;
    else this.history.pushState(MARKER, "");
    return () => {
      const index = this.entries.indexOf(entry);
      if (index === -1) return; // Back already removed it.
      this.entries.splice(index, 1);
      this.stale += 1;
      this.defer(() => {
        if (this.stale === 0) return; // Reused by an overlay that opened meanwhile.
        this.stale -= 1;
        this.ignore += 1;
        this.history.back();
      });
    };
  }

  onPopState(): void {
    if (this.ignore > 0) {
      this.ignore -= 1;
      return;
    }
    if (this.stale > 0) {
      // Back landed on an entry whose overlay is already gone; it is consumed.
      this.stale -= 1;
      return;
    }
    const top = this.entries.pop();
    if (!top) return;
    if (top.close() === false) {
      // Undismissable: put it back where its rank belongs, not at the end.
      this.insert(top);
      this.history.pushState(MARKER, "");
    }
  }
}
