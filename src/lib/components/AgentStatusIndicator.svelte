<!-- src/lib/components/AgentStatusIndicator.svelte -->
<script lang="ts">
  import type { AgentStatusCounts } from '$lib/types/agentStatus';
  import { getStatusColorFromCounts, getTooltipFromCounts } from '$lib/types/agentStatus';

  interface Props {
    counts: AgentStatusCounts;
    size?: 'small' | 'medium';
  }

  let { counts, size = 'small' }: Props = $props();

  const color = $derived(getStatusColorFromCounts(counts));
  const tooltip = $derived(getTooltipFromCounts(counts));
</script>

<div
  class="status-indicator {size}"
  class:green={color === 'green'}
  class:red={color === 'red'}
  class:mixed={color === 'mixed'}
  class:grey={color === 'grey'}
  title={tooltip}
  role="status"
  aria-label={tooltip}
>
  {#if color === 'mixed'}
    <div class="mixed-top"></div>
    <div class="mixed-bottom"></div>
  {/if}
</div>

<style>
  @keyframes pulse-red {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.6;
    }
  }

  .status-indicator {
    border-radius: 2px;
    flex-shrink: 0;
    transition: background-color 0.2s ease;
  }

  .status-indicator.small {
    width: 6px;
    height: 16px;
  }

  .status-indicator.medium {
    width: 8px;
    height: 24px;
  }

  .status-indicator.green {
    background: var(--vscode-testing-iconPassed, #73c991);
  }

  @media (prefers-reduced-motion: no-preference) {
    .status-indicator.red {
      animation: pulse-red 2s ease-in-out infinite;
    }
  }

  .status-indicator.red {
    background: var(--vscode-testing-iconFailed, #f14c4c);
  }

  .status-indicator.grey {
    background: var(--vscode-descriptionForeground, #969696);
    opacity: 0.4;
  }

  @media (prefers-reduced-motion: no-preference) {
    .status-indicator.mixed {
      animation: pulse-red 2s ease-in-out infinite;
    }
  }

  .status-indicator.mixed {
    display: flex;
    flex-direction: column;
    background: transparent;
    overflow: hidden;
  }

  .mixed-top {
    flex: 1;
    background: var(--vscode-testing-iconFailed, #f14c4c);
  }

  .mixed-bottom {
    flex: 1;
    background: var(--vscode-testing-iconPassed, #73c991);
  }
</style>
