<!--
  Spinner.svelte

  The sidebar's spinning ring: a busy agent (red), a workspace still loading
  or a spinner notification (neutral). Its head is a comet, a bright arc that
  fades back into the track, so the stepped turn reads as motion rather than
  jumps. It turns in 8 steps a second on the shared clock (spin-clock.ts), so
  any number of spinners costs about 8 frames a second instead of one per
  vsync.
-->
<script lang="ts">
  import { spinClock } from "./spin-clock.js";

  interface Props {
    /** busy: an agent at work (red); neutral: loading, a spinner note. */
    tone?: "busy" | "neutral";
    /** The count-sized ring (9px) of the project header and summary. */
    small?: boolean;
    /** Stands still. */
    still?: boolean;
    title?: string;
    /** Extra classes for the caller's own markers (e.g. `pending`). */
    class?: string;
  }

  const {
    tone = "neutral",
    small = false,
    still = false,
    title,
    class: extra = "",
  }: Props = $props();
</script>

<span
  class="ring {extra}"
  class:busy={tone === "busy"}
  class:small
  class:still
  {title}
  use:spinClock
></span>

<style>
  /* Track and comet head are one conic gradient (the head at 12 o'clock,
     fading back over ~210°), masked down to a ring --ring-width wide. */
  .ring {
    --ring-width: 2px;
    --ring-track: var(--ch-sb-spin-track);
    --ring-head: var(--ch-sb-spin-head);
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: conic-gradient(var(--ring-track) 150deg, var(--ring-head));
    mask: radial-gradient(
      farthest-side,
      transparent calc(100% - var(--ring-width) - 0.5px),
      #000 calc(100% - var(--ring-width))
    );
    animation: spin 1s steps(8) infinite;
    display: block;
  }
  .ring.busy {
    --ring-track: var(--ch-sb-busy-track);
    --ring-head: var(--ch-sb-busy);
  }
  .ring.small {
    --ring-width: 1.5px;
    width: 9px;
    height: 9px;
  }
  .ring.still {
    animation: none;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ring {
      animation: none;
    }
  }
</style>
