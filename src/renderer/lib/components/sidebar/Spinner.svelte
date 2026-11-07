<!--
  Spinner.svelte

  The sidebar's spinning ring: a busy agent (red), a workspace still loading
  or a spinner notification (neutral). It turns in 8 steps every 2 s on the
  shared clock (spin-clock.ts), so any number of spinners costs about 4 frames
  a second instead of one per vsync.
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
  .ring {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: 2px solid var(--ch-sb-spin-track);
    border-top-color: var(--ch-sb-spin-head);
    animation: spin 2s steps(8) infinite;
    display: block;
    box-sizing: border-box;
  }
  .ring.busy {
    border-color: var(--ch-sb-busy-track);
    border-top-color: var(--ch-sb-busy);
  }
  .ring.small {
    width: 9px;
    height: 9px;
    border-width: 1.5px;
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
