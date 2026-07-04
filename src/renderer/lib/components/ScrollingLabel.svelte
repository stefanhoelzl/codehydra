<script lang="ts">
  import type { Snippet } from "svelte";
  import type { SidebarLabelScroll } from "@shared/ui-state";

  interface Props {
    /** How this line scrolls when its content overflows the rail. */
    mode: SidebarLabelScroll;
    /** True while the owning row is hovered (drives `hover` mode). */
    hovered: boolean;
    /** The line content (text, and for line 2 the branch + tag pills). */
    children: Snippet;
  }

  let { mode, hovered, children }: Props = $props();

  let box: HTMLElement | undefined;
  let inner: HTMLElement | undefined;

  // Overflow geometry, measured from the DOM (0 in non-layout environments like
  // jsdom, which harmlessly reads as "not overflowing").
  let overflowPx = $state(0);

  function measure(): void {
    if (!box || !inner) return;
    overflowPx = Math.max(0, inner.scrollWidth - box.clientWidth);
  }

  // Re-measure whenever the box or its content changes size. ResizeObserver on
  // the inner element catches text/tag changes; on the box, rail width changes.
  $effect(() => {
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    if (box) ro.observe(box);
    if (inner) ro.observe(inner);
    return () => ro.disconnect();
  });

  const overflowing = $derived(overflowPx > 2);
  const animate = $derived(overflowing && mode !== "off");
  const running = $derived(mode === "always" || (mode === "hover" && hovered));
  // Duration scales with distance so short and long labels scroll at a similar
  // readable pace; clamped so very long labels don't crawl.
  const durationSec = $derived(Math.min(14, 3.5 + overflowPx / 22));
</script>

<div class="scroll" class:overflowing bind:this={box}>
  <span
    class="scroll-inner"
    class:marquee={animate}
    class:paused={animate && !running}
    style:--shift="-{overflowPx}px"
    style:--dur="{durationSec}s"
    bind:this={inner}
  >
    {@render children()}
  </span>
</div>

<style>
  .scroll {
    overflow: hidden;
    min-width: 0;
  }

  /* A clipped line fades at its trailing edge to signal "there's more". */
  .scroll.overflowing {
    -webkit-mask-image: linear-gradient(90deg, #000 88%, transparent 100%);
    mask-image: linear-gradient(90deg, #000 88%, transparent 100%);
  }

  .scroll-inner {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    will-change: transform;
  }

  /* Ping-pong: run to the end, pause, return. */
  .scroll-inner.marquee {
    animation: label-marquee var(--dur, 6s) linear infinite;
  }

  .scroll-inner.marquee.paused {
    animation-play-state: paused;
    transform: translateX(0);
  }

  @keyframes label-marquee {
    0%,
    12% {
      transform: translateX(0);
    }
    48%,
    60% {
      transform: translateX(var(--shift, 0));
    }
    96%,
    100% {
      transform: translateX(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .scroll-inner.marquee {
      animation: none;
      transform: translateX(0);
    }
  }
</style>
