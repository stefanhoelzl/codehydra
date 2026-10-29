<!--
  WorkspaceOptionRow.svelte

  A dropdown option drawn as a sidebar workspace row: the title (else the
  name), a second line with the branch (when titled) and the tags, and the
  status icon on the right — the agent dot, or a pause icon when hibernated.
  The sidebar's hover actions and shortcut badges have no place in a list.
-->
<script lang="ts">
  import type { DropdownWorkspaceRow } from "@shared/dialog-types";
  import AgentStatusIndicator from "./AgentStatusIndicator.svelte";
  import Icon from "./Icon.svelte";
  import WorkspaceTags from "./WorkspaceTags.svelte";

  interface Props {
    row: DropdownWorkspaceRow;
  }

  const { row }: Props = $props();

  const counts = $derived("counts" in row.agent ? row.agent.counts : { idle: 0, busy: 0 });
  const showSecondLine = $derived(row.title !== undefined || row.tags.length > 0);
</script>

<span class="workspace-option-row" class:hibernated={row.hibernated}>
  <span class="ws-label">
    <span class="ws-primary">{row.title ?? row.name}</span>
    {#if showSecondLine}
      <span class="ws-secondary">
        {#if row.title !== undefined}
          <span class="ws-branch">{row.name}</span>
        {/if}
        <WorkspaceTags tags={row.tags} />
      </span>
    {/if}
  </span>
  <span class="ws-status">
    {#if row.hibernated}
      <span class="hibernation-indicator" role="img" aria-label="Hibernated">
        <Icon name="debug-pause" size={14} />
      </span>
    {:else}
      <AgentStatusIndicator idleCount={counts.idle} busyCount={counts.busy} />
    {/if}
  </span>
</span>

<style>
  .workspace-option-row {
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }

  .ws-label {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .ws-primary {
    line-height: 18px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ws-secondary {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 3px 6px;
    font-size: 11px;
  }

  .ws-branch {
    opacity: 0.6;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  /* Centered on the first line, like the sidebar's status cell. */
  .ws-status {
    height: 18px;
    width: 18px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .hibernation-indicator {
    display: flex;
    opacity: 0.55;
  }

  .hibernated .ws-label {
    opacity: 0.55;
    font-style: italic;
  }
</style>
