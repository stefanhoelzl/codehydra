<script lang="ts">
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

  // Generate status text for aria-label and tooltip
  const statusText = $derived.by(() => {
    if (status === "none") {
      return "No agents running";
    }
    if (status === "idle") {
      const noun = idleCount === 1 ? "agent" : "agents";
      return `${idleCount} ${noun} idle`;
    }
    if (status === "busy") {
      const noun = busyCount === 1 ? "agent" : "agents";
      return `${busyCount} ${noun} busy`;
    }
    // mixed
    return `${idleCount} idle, ${busyCount} busy`;
  });

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
    width: 6px;
    height: 16px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .indicator:focus {
    outline: 1px solid var(--ch-focus-border);
    outline-offset: 2px;
  }

  /* None state - grey with low opacity */
  .indicator--none {
    background-color: var(--ch-foreground);
    opacity: 0.4;
  }

  /* Idle state - green */
  .indicator--idle {
    background-color: #4caf50;
  }

  /* Busy state - red */
  .indicator--busy {
    background-color: #f44336;
  }

  /* Mixed state - gradient (red top, green bottom) */
  .indicator--mixed {
    background: linear-gradient(to bottom, #f44336 50%, #4caf50 50%);
  }

  /* Pulse animation for busy and mixed states - uses global ch-pulse keyframes */
  .indicator--pulsing {
    animation: ch-pulse 1.5s ease-in-out infinite;
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
    border-radius: 4px;
    font-size: 12px;
    white-space: nowrap;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    z-index: 1000;
    pointer-events: none;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
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
