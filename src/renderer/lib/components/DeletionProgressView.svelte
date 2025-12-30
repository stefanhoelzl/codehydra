<!--
  DeletionProgressView.svelte
  
  Shows deletion progress for a workspace with operation status indicators.
  Displayed in the workspace area when the active workspace is being deleted.
-->
<script lang="ts">
  import Logo from "./Logo.svelte";
  import Icon from "./Icon.svelte";
  import type { DeletionProgress, DeletionOperationStatus } from "@shared/api/types";

  interface Props {
    progress: DeletionProgress;
    onRetry: () => void;
    onCloseAnyway: () => void;
  }

  const { progress, onRetry, onCloseAnyway }: Props = $props();

  // Find the first error message from operations
  const firstError = $derived(progress.operations.find((op) => op.error)?.error ?? null);

  // Get status icon name for an operation
  function getStatusIconName(status: DeletionOperationStatus): string | null {
    switch (status) {
      case "done":
        return "check";
      case "error":
        return "close";
      case "pending":
        return "circle-large";
      default:
        return null;
    }
  }

  // Get screen reader text for a status
  function getStatusText(status: DeletionOperationStatus): string {
    switch (status) {
      case "pending":
        return "Pending";
      case "in-progress":
        return "In progress";
      case "done":
        return "Complete";
      case "error":
        return "Error";
    }
  }
</script>

<div class="deletion-progress-view">
  <div class="backdrop-logo">
    <Logo animated={false} />
  </div>

  <div class="progress-card">
    <h2 class="title">Removing workspace</h2>
    <p class="workspace-name">"{progress.workspaceName}"</p>

    <ul class="operations-list" role="list" aria-live="polite">
      {#each progress.operations as operation (operation.id)}
        <li class="operation-item" role="listitem">
          <span class="status-indicator status-{operation.status}" aria-hidden="true">
            {#if operation.status === "in-progress"}
              <vscode-progress-ring class="spinner"></vscode-progress-ring>
            {:else}
              {@const iconName = getStatusIconName(operation.status)}
              {#if iconName}
                <Icon name={iconName} />
              {/if}
            {/if}
          </span>
          <span class="operation-label">{operation.label}</span>
          <span class="ch-visually-hidden">{getStatusText(operation.status)}</span>
        </li>
      {/each}
    </ul>

    {#if firstError}
      <div class="error-box" role="alert">
        <span class="error-icon" aria-hidden="true">
          <Icon name="warning" />
        </span>
        <span class="error-text">Error: {firstError}</span>
      </div>
    {/if}

    {#if progress.completed && progress.hasErrors}
      <div class="action-buttons">
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <vscode-button onclick={onRetry}>Retry</vscode-button>
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <vscode-button secondary={true} onclick={onCloseAnyway}>Close Anyway</vscode-button>
      </div>
    {/if}
  </div>
</div>

<style>
  .deletion-progress-view {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: var(--ch-sidebar-minimized-width, 20px);
    background: var(--ch-background);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 0;
  }

  .backdrop-logo {
    position: absolute;
    opacity: var(--ch-logo-backdrop-opacity, 0.15);
  }

  .backdrop-logo :global(img) {
    width: min(256px, 30vw);
    height: min(256px, 30vw);
  }

  .progress-card {
    position: relative;
    background: var(--ch-background);
    border: 1px solid var(--ch-border);
    border-radius: 4px;
    padding: 24px 32px;
    max-width: 400px;
    width: 100%;
    box-shadow: var(--ch-shadow);
  }

  .title {
    margin: 0 0 8px 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--ch-foreground);
    text-align: center;
  }

  .workspace-name {
    margin: 0 0 20px 0;
    font-size: 14px;
    color: var(--ch-foreground);
    opacity: 0.8;
    text-align: center;
    word-break: break-all;
  }

  .operations-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .operation-item {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
    color: var(--ch-foreground);
  }

  .status-indicator {
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-size: 14px;
  }

  .status-pending {
    color: var(--ch-foreground);
    opacity: 0.5;
  }

  .status-in-progress {
    color: var(--ch-foreground);
  }

  .status-done {
    --vscode-icon-foreground: var(--ch-success);
  }

  .status-error {
    --vscode-icon-foreground: var(--ch-danger);
  }

  .spinner {
    width: 16px;
    height: 16px;
  }

  .operation-label {
    flex: 1;
  }

  .error-box {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-top: 16px;
    padding: 10px 12px;
    background: var(--ch-error-bg);
    border-radius: 2px;
    font-size: 13px;
    color: var(--ch-error-fg);
  }

  .error-icon {
    --vscode-icon-foreground: var(--ch-error-fg);
    flex-shrink: 0;
  }

  .error-text {
    word-break: break-word;
  }

  .action-buttons {
    display: flex;
    gap: 12px;
    justify-content: center;
    margin-top: 20px;
  }
</style>
