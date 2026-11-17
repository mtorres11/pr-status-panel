// Refreshes where only the newest one counts: a refresh started while another runs makes the older one's
// results stale, so a slow answer never overwrites a newer list.

export class LatestWins {
  private generation = 0;
  private running = false;

  /** `changed` is called when loading starts and when the newest refresh ends. */
  constructor(private readonly changed: () => void) {}

  get loading(): boolean {
    return this.running;
  }

  /**
   * Runs `task` unless one is already running and `force` is false. The task gets `isCurrent`, and must apply
   * its results only while it returns true; `fail` gets the error of the newest run only.
   */
  async run(
    force: boolean,
    task: (isCurrent: () => boolean) => Promise<void>,
    fail: (e: Error) => void,
  ): Promise<void> {
    if (!force && this.running) return;
    const gen = ++this.generation;
    const isCurrent = () => gen === this.generation;
    this.running = true;
    this.changed();
    try {
      await task(isCurrent);
    } catch (e) {
      if (isCurrent()) fail(e as Error);
    } finally {
      if (isCurrent()) {
        this.running = false;
        this.changed();
      }
    }
  }
}
