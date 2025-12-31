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
    onKillAndRetry: () => void;
  }

  const { progress, onRetry, onCloseAnyway, onKillAndRetry }: Props = $props();

  // Track which button was clicked for spinner
  let activeButton = $state<"retry" | "kill" | "close" | null>(null);

  // Reference to Retry button for focus management
  let retryButtonRef = $state<HTMLElement | null>(null);

  // Derived: is any operation in progress?
  const isOperating = $derived(activeButton !== null);

  // Find the first error message from operations
  const firstError = $derived(progress.operations.find((op) => op.error)?.error ?? null);

  // Check if we have blocking processes to show
  const hasBlockingProcesses = $derived(
    progress.blockingProcesses && progress.blockingProcesses.length > 0
  );

  // Reset activeButton when a new deletion cycle starts (progress.completed becomes false)
  // This allows buttons to be re-enabled when the user clicks retry and new progress arrives
  $effect(() => {
    if (!progress.completed && activeButton !== null) {
      activeButton = null;
    }
  });

  // Focus Retry button when blocking processes error state appears (for accessibility)
  $effect(() => {
    if (progress.completed && progress.hasErrors && hasBlockingProcesses && retryButtonRef) {
      // Use requestAnimationFrame to ensure button is rendered before focusing
      requestAnimationFrame(() => {
        retryButtonRef?.focus();
      });
    }
  });

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

  // Handle button clicks
  function handleRetry() {
    activeButton = "retry";
    onRetry();
  }

  function handleKillAndRetry() {
    activeButton = "kill";
    onKillAndRetry();
  }

  function handleCloseAnyway() {
    activeButton = "close";
    onCloseAnyway();
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

    {#if hasBlockingProcesses}
      <div class="blocking-processes">
        <table class="process-table">
          <caption class="ch-visually-hidden">Processes blocking workspace deletion</caption>
          <thead>
            <tr>
              <th scope="col">PID</th>
              <th scope="col">Process</th>
              <th scope="col">Command</th>
            </tr>
          </thead>
          <tbody>
            {#each progress.blockingProcesses ?? [] as proc (proc.pid)}
              <tr>
                <td class="pid-cell">{proc.pid}</td>
                <td class="name-cell">{proc.name}</td>
                <td class="command-cell" title={proc.commandLine}>{proc.commandLine}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    {#if progress.completed && progress.hasErrors}
      <div class="action-buttons">
        {#if hasBlockingProcesses}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <vscode-button class="danger-button" disabled={isOperating} onclick={handleKillAndRetry}>
            {#if activeButton === "kill"}
              <Icon name="loading" spin /> Killing...
            {:else}
              Kill Processes & Retry
            {/if}
          </vscode-button>
        {/if}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <vscode-button
          bind:this={retryButtonRef}
          secondary={true}
          disabled={isOperating}
          onclick={handleRetry}
        >
          {#if activeButton === "retry"}
            <Icon name="loading" spin /> Retrying...
          {:else}
            Retry
          {/if}
        </vscode-button>
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <vscode-button secondary={true} disabled={isOperating} onclick={handleCloseAnyway}>
          {#if activeButton === "close"}
            <Icon name="loading" spin /> Closing...
          {:else}
            Close Anyway
          {/if}
        </vscode-button>
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

  .blocking-processes {
    margin-top: 16px;
    border: 1px solid var(--ch-border);
    border-radius: 4px;
    overflow: hidden;
  }

  .process-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .process-table th,
  .process-table td {
    padding: 6px 10px;
    text-align: left;
    border-bottom: 1px solid var(--ch-border);
  }

  .process-table th {
    background: var(--ch-header-bg, rgba(255, 255, 255, 0.04));
    font-weight: 500;
    color: var(--ch-foreground);
  }

  .process-table tbody tr:last-child td {
    border-bottom: none;
  }

  .pid-cell {
    width: 60px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--ch-foreground);
    opacity: 0.8;
  }

  .name-cell {
    width: 100px;
    color: var(--ch-foreground);
  }

  .command-cell {
    max-width: 50ch;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--ch-foreground);
    opacity: 0.8;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }

  /* Danger button styling */
  .danger-button {
    --vscode-button-background: var(--ch-danger);
    --vscode-button-hoverBackground: var(--ch-danger-hover, #c42b1c);
    --vscode-button-foreground: var(--ch-background);
  }
</style>
