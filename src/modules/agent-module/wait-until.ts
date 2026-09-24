/**
 * Wake-up list for callers waiting on a condition that other code changes.
 *
 * The owner of the state calls {@link ConditionWaiters.notify} whenever it
 * changes something a waiter might be checking; each waiter re-runs its own
 * check. No polling, and a waiter that times out is dropped from the list.
 */
export class ConditionWaiters {
  private readonly waiters = new Set<() => void>();

  /**
   * Resolve true as soon as `check()` holds — now, or on a later
   * {@link notify} — and false once `waitMs` has passed without it.
   * `waitMs <= 0` checks once and never waits.
   */
  waitUntil(check: () => boolean, waitMs: number): Promise<boolean> {
    if (check()) return Promise.resolve(true);
    if (waitMs <= 0) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      const recheck = (): void => {
        if (!check()) return;
        clearTimeout(timer);
        this.waiters.delete(recheck);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(recheck);
        resolve(check());
      }, waitMs);
      this.waiters.add(recheck);
    });
  }

  /** Re-run every pending waiter's check. */
  notify(): void {
    for (const recheck of [...this.waiters]) recheck();
  }
}
