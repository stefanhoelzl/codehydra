/**
 * Bounded waits. Every hand-rolled `Promise.race` against a `setTimeout` has to
 * clear its timer once the race settles, or the timer keeps the event loop (and
 * the closure it captured) alive for the full duration; these helpers always do.
 */

/** What {@link raceTimeout} resolves with when the deadline passes first. */
export const TIMED_OUT: unique symbol = Symbol("timed-out");

/**
 * Wait for `promise`, but no longer than `ms`. Resolves with its value, or with
 * {@link TIMED_OUT} when the deadline passes first; rejects if `promise` does.
 * The timer is cleared either way.
 */
export async function raceTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait for `promise`, but no longer than `ms`: rejects with `onTimeout()` when the
 * deadline passes first. The timer is cleared either way.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error
): Promise<T> {
  const result = await raceTimeout(promise, ms);
  if (result === TIMED_OUT) throw onTimeout();
  return result;
}
