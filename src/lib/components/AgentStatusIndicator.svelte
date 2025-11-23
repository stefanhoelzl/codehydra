<!-- src/lib/components/AgentStatusIndicator.svelte -->
<script lang="ts">
  import type { AggregatedAgentStatus } from '$lib/types/agentStatus';
  import { getStatusColor, getStatusTooltip } from '$lib/types/agentStatus';

  interface Props {
    status: AggregatedAgentStatus;
    size?: 'small' | 'medium';
  }

  let { status, size = 'small' }: Props = $props();

  const color = $derived(getStatusColor(status));
  const tooltip = $derived(getStatusTooltip(status));
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
  .status-indicator {
    border-radius: 2px;
    flex-shrink: 0;
    transition: background-color 0.2s ease;
  }

  .status-indicator.small {
    width: 3px;
    height: 16px;
  }

  .status-indicator.medium {
    width: 4px;
    height: 24px;
  }

  .status-indicator.green {
    background: var(--vscode-testing-iconPassed, #73c991);
  }

  .status-indicator.red {
    background: var(--vscode-testing-iconFailed, #f14c4c);
  }

  .status-indicator.grey {
    background: var(--vscode-descriptionForeground, #969696);
    opacity: 0.4;
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
