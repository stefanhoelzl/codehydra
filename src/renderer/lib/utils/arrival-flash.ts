/**
 * Arrival flash — the `in:` transition played by a sidebar workspace row when
 * it enters the DOM.
 *
 * It exists because a workspace can appear without the user putting it there:
 * an agent creates one over MCP, an auto-workspace source polls one in. Those
 * arrivals are deliberately NOT allowed to steal the view while the sidebar is
 * expanded (see the presentation module's `suppress-background-focus`
 * interceptor), so the row itself has to say "something landed here".
 *
 * Row introduction is the trigger, which Svelte already tracks for a keyed
 * `{#each}` — no bookkeeping of seen keys. The flip side is that a row coming
 * BACK (un-hiding hibernated rows, reopening a closed project) flashes too;
 * both are actions the user just took, so it reads as confirmation.
 *
 * The tint is an inset box-shadow rather than a background, so it layers over
 * whatever the row already paints (active selection, hover, hibernated dim)
 * instead of replacing it for the duration.
 */

import { linear } from "svelte/easing";
import type { TransitionConfig } from "svelte/transition";

/** Full-strength tint, as a color-mix percentage against transparent. */
const PEAK_PERCENT = 22;
/** Two pulses. */
const PULSE_DURATION_MS = 1200;
/** One fade in and back out, for prefers-reduced-motion. */
const REDUCED_DURATION_MS = 400;

export interface ArrivalFlashParams {
  /**
   * Override the prefers-reduced-motion probe. Only tests pass this; the
   * component relies on the media query below.
   */
  readonly reducedMotion?: boolean;
}

/** True when the OS asks for reduced motion. Falls back to false where `matchMedia` is absent. */
function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Tint strength at progress `t` (0..1), as a percentage.
 *
 * Two humps: |sin(2πt)| is zero at t = 0, 0.5, 1 and peaks at t = 0.25, 0.75.
 * Reduced motion collapses that to the single hump of sin(πt) — the arrival is
 * still announced, the throbbing is gone.
 */
export function flashStrength(t: number, reducedMotion: boolean): number {
  const wave = reducedMotion ? Math.sin(Math.PI * t) : Math.abs(Math.sin(2 * Math.PI * t));
  return PEAK_PERCENT * wave;
}

/**
 * Svelte `in:` transition. `node` is unused — the whole animation is expressed
 * as sampled CSS, which keeps this a pure function of `t`.
 */
export function arrivalFlash(_node: Element, params?: ArrivalFlashParams): TransitionConfig {
  const reducedMotion = params?.reducedMotion ?? prefersReducedMotion();
  return {
    duration: reducedMotion ? REDUCED_DURATION_MS : PULSE_DURATION_MS,
    easing: linear,
    css: (t: number): string =>
      `box-shadow: inset 0 0 0 999px color-mix(in srgb, var(--ch-arrival-flash, var(--vscode-focusBorder, #0078d4)) ${flashStrength(
        t,
        reducedMotion
      ).toFixed(2)}%, transparent)`,
  };
}
