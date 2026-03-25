<script lang="ts">
  import { getStatusText } from "$lib/utils/sidebar-utils";

  interface AgentStatusIndicatorProps {
    idleCount: number;
    busyCount: number;
  }

  let { idleCount, busyCount }: AgentStatusIndicatorProps = $props();

  // Derive status type from counts
  const status = $derived.by(() => {
    if (idleCount === 0 && busyCount === 0) return "none";
    if (idleCount > 0 && busyCount === 0) return "idle";
    if (idleCount === 0 && busyCount > 0) return "busy";
    return "mixed";
  });

  // Derive if pulsing animation should be applied
  const isPulsing = $derived(status === "busy" || status === "mixed");

  // Pulse animation timing - single source of truth
  const PULSE_DURATION_MS = 1500;
  // Negative delay synchronizes all pulsing indicators to the same phase
  const pulseDelay = $derived(isPulsing ? -(performance.now() % PULSE_DURATION_MS) : 0);

  // Generate status text for aria-label and tooltip using shared utility
  const statusText = $derived(getStatusText(idleCount, busyCount));

  // Tooltip visibility state
  let showTooltip = $state(false);
  let tooltipTimeout: ReturnType<typeof setTimeout> | null = null;

  // Handle mouse/focus enter - start tooltip delay
  function handleShowTooltip(): void {
    if (tooltipTimeout) {
      clearTimeout(tooltipTimeout);
    }
    tooltipTimeout = setTimeout(() => {
      showTooltip = true;
    }, 500);
  }

  // Handle mouse/focus leave - hide tooltip
  function handleHideTooltip(): void {
    if (tooltipTimeout) {
      clearTimeout(tooltipTimeout);
      tooltipTimeout = null;
    }
    showTooltip = false;
  }

  // Handle keydown for Escape to dismiss tooltip
  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      handleHideTooltip();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- tabindex="0" and events are intentional for keyboard accessibility: allows focus to show/dismiss tooltip -->
<div
  class="indicator indicator--{status}"
  class:indicator--pulsing={isPulsing}
  style:--pulse-delay="{pulseDelay}ms"
  style:--pulse-duration="{PULSE_DURATION_MS}ms"
  role="status"
  aria-live="polite"
  aria-label={statusText}
  tabindex="0"
  onmouseenter={handleShowTooltip}
  onmouseleave={handleHideTooltip}
  onfocus={handleShowTooltip}
  onblur={handleHideTooltip}
  onkeydown={handleKeyDown}
>
  {#if showTooltip}
    <div class="tooltip" role="tooltip">
      {statusText}
    </div>
  {/if}
</div>

<style>
  .indicator {
    position: relative;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .indicator:focus {
    outline: 1px solid var(--ch-focus-border);
    outline-offset: 2px;
  }

  /* None state - grey with low opacity */
  .indicator--none {
    background-color: var(--ch-foreground);
    opacity: 0.5;
  }

  /* Idle state - green dot with glow */
  .indicator--idle {
    background-color: var(--ch-agent-idle);
    box-shadow: var(--ch-status-glow-idle);
  }

  /* Busy state - red dot with glow */
  .indicator--busy {
    background-color: var(--ch-agent-busy);
    box-shadow: var(--ch-status-glow-busy);
  }

  /* Mixed state - red dot with glow (same as busy) */
  .indicator--mixed {
    background-color: var(--ch-agent-busy);
    box-shadow: var(--ch-status-glow-busy);
  }

  /* Synchronized pulse animation for busy and mixed states */
  @keyframes ch-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }

  .indicator--pulsing {
    animation: ch-pulse var(--pulse-duration) ease-in-out infinite;
    animation-delay: var(--pulse-delay);
  }

  /* Respect reduced motion preference */
  @media (prefers-reduced-motion: reduce) {
    .indicator--pulsing {
      animation: none;
    }
  }

  /* Tooltip styles */
  .tooltip {
    position: absolute;
    right: calc(100% + 8px);
    top: 50%;
    transform: translateY(-50%);
    background: var(--ch-input-bg);
    color: var(--ch-foreground);
    padding: 4px 8px;
    border-radius: var(--ch-radius-sm, 6px);
    font-size: 12px;
    white-space: nowrap;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    z-index: 1000;
    pointer-events: none;
    box-shadow: var(--ch-shadow);
  }

  /* Tooltip arrow */
  .tooltip::after {
    content: "";
    position: absolute;
    left: 100%;
    top: 50%;
    transform: translateY(-50%);
    border: 4px solid transparent;
    border-left-color: var(--ch-input-bg);
  }
</style>
