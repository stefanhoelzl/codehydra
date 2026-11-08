/**
 * One clock for every looping sidebar animation (spinners, the indeterminate
 * progress bar).
 *
 * The loops step 8 times a second (spinners `steps(8)` over 1 s, the progress
 * bar `steps(16)` over 2 s): the compositor draws a frame only when a step
 * lands, 8 a second, where a smooth loop draws every vsync. That holds only
 * while the loops are in phase: each CSS animation starts when its element
 * appears, so spinners mounted at different times step on different frames,
 * and N of them cost N × 8 frames a second.
 * Pinning each animation's start to the document timeline's origin puts them
 * all on the same frames, whatever their number.
 */

/** Pin the element's running animations to the shared clock. */
function pin(el: Element): void {
  // happy-dom (the renderer tests' DOM) has no Element.getAnimations.
  if (typeof el.getAnimations !== "function") return;
  for (const animation of el.getAnimations()) animation.startTime = 0;
}

/**
 * Svelte action: keep the element's CSS animations on the shared clock. A
 * restarted animation (its `animation` turned off and on, e.g. `still`) is a
 * new one, so it is pinned again when it starts.
 */
export function spinClock(el: Element): { destroy: () => void } {
  pin(el);
  const onStart = (): void => pin(el);
  el.addEventListener("animationstart", onStart);
  return { destroy: () => el.removeEventListener("animationstart", onStart) };
}
