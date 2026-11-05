/**
 * Shared clocks for labels that age (hibernation age, busy time). Reading one
 * inside a reactive context subscribes that context to one app-wide tick of
 * that clock; its interval runs only while something reads it.
 */

import { createSubscriber } from "svelte/reactivity";

/** A clock ticking every `intervalMs`: returns the current time, re-read on each tick. */
export function createClock(intervalMs: number): () => number {
  const subscribe = createSubscriber((update) => {
    const id = setInterval(update, intervalMs);
    return () => clearInterval(id);
  });
  return () => {
    subscribe();
    return Date.now();
  };
}

/** The current time; re-read by its reactive readers once a minute. */
export const minuteNow = createClock(60_000);

/** The current time; re-read by its reactive readers once a second. */
export const secondNow = createClock(1_000);
