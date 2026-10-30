/**
 * A shared clock for labels that age (hibernation age). Reading it inside a
 * reactive context subscribes that context to one app-wide 60 s tick; the
 * interval runs only while something reads it.
 */

import { createSubscriber } from "svelte/reactivity";

const TICK_MS = 60_000;

const subscribe = createSubscriber((update) => {
  const id = setInterval(update, TICK_MS);
  return () => clearInterval(id);
});

/** The current time; re-read by its reactive readers once a minute. */
export function minuteNow(): number {
  subscribe();
  return Date.now();
}
