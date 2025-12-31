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
    onCancel: () => void;
    onKillAndRetry: () => void;
    onCloseHandlesAndRetry: () => void;
  }

  const { progress, onRetry, onCancel, onKillAndRetry, onCloseHandlesAndRetry }: Props = $props();

  // Track which button was clicked for spinner
  let activeButton = $state<"retry" | "kill" | "close" | "cancel" | null>(null);

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

  // Count total processes and files for header
  const processCount = $derived(progress.blockingProcesses?.length ?? 0);
  const fileCount = $derived(
    progress.blockingProcesses?.reduce((sum, proc) => sum + proc.files.length, 0) ?? 0
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

  // Truncate command line for display: first 30 + ... + last 20 chars
  function truncateCommandLine(commandLine: string): string {
    const maxLength = 60;
    if (commandLine.length <= maxLength) return commandLine;
    return commandLine.slice(0, 30) + "..." + commandLine.slice(-20);
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

  function handleCloseHandlesAndRetry() {
    activeButton = "close";
    onCloseHandlesAndRetry();
  }

  function handleCancel() {
    activeButton = "cancel";
    onCancel();
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
      <div class="blocking-processes-header">
        <Icon name="warning" label="Warning" />
        <span>Deletion blocked by {processCount} process(es) holding {fileCount} file(s)</span>
      </div>
      <div
        class="blocking-processes"
        class:dimmed={isOperating}
        role="region"
        aria-label="Blocking processes and files"
      >
        {#each progress.blockingProcesses ?? [] as proc (proc.pid)}
          <div class="process-item">
            <div class="process-header">
              <span class="process-name">{proc.name}</span>
              <span class="process-pid">(PID {proc.pid})</span>
            </div>
            <div class="process-command" title={proc.commandLine}>
              {truncateCommandLine(proc.commandLine)}
            </div>
            {#if proc.cwd !== null}
              <div class="process-cwd">Working directory: {proc.cwd}/</div>
            {/if}
            {#if proc.files.length > 0}
              <ul class="process-files">
                {#each proc.files.slice(0, 20) as file (file)}
                  <li>{file}</li>
                {/each}
                {#if proc.files.length > 20}
                  <li class="files-more">(and {proc.files.length - 20} more files)</li>
                {/if}
              </ul>
            {:else if proc.cwd === null}
              <div class="no-files">(no files detected)</div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if progress.completed && progress.hasErrors}
      <div class="action-buttons">
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <vscode-button bind:this={retryButtonRef} disabled={isOperating} onclick={handleRetry}>
          {#if activeButton === "retry"}
            <Icon name="loading" spin /> Retrying...
          {:else}
            Retry
          {/if}
        </vscode-button>
        {#if hasBlockingProcesses}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <vscode-button
            class="warning-button"
            appearance="secondary"
            disabled={isOperating}
            onclick={handleKillAndRetry}
          >
            {#if activeButton === "kill"}
              <Icon name="loading" spin /> Killing...
            {:else}
              Kill & Retry
            {/if}
          </vscode-button>
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <vscode-button
            class="danger-button"
            appearance="secondary"
            disabled={isOperating}
            onclick={handleCloseHandlesAndRetry}
          >
            {#if activeButton === "close"}
              <Icon name="loading" spin /> Closing...
            {:else}
              Close Handles & Retry
            {/if}
          </vscode-button>
        {/if}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <vscode-button appearance="secondary" disabled={isOperating} onclick={handleCancel}>
          {#if activeButton === "cancel"}
            <Icon name="loading" spin /> Cancelling...
          {:else}
            Cancel
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
    flex-wrap: wrap;
    margin-top: 20px;
  }

  .blocking-processes-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 16px;
    margin-bottom: 8px;
    font-size: 13px;
    color: var(--ch-warning);
  }

  .blocking-processes {
    max-height: 300px;
    overflow-y: auto;
    border: 1px solid var(--ch-border);
    border-radius: 4px;
    padding: 8px;
  }

  .blocking-processes.dimmed {
    opacity: 0.5;
  }

  .process-item {
    margin-bottom: 12px;
  }

  .process-item:last-child {
    margin-bottom: 0;
  }

  .process-header {
    font-size: 13px;
    font-weight: 500;
    color: var(--ch-foreground);
  }

  .process-name {
    color: var(--ch-foreground);
  }

  .process-pid {
    color: var(--ch-foreground);
    opacity: 0.6;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    margin-left: 4px;
  }

  .process-command {
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--ch-foreground);
    opacity: 0.7;
    margin-top: 2px;
    word-break: break-all;
  }

  .process-cwd {
    font-size: 12px;
    color: var(--ch-foreground);
    opacity: 0.8;
    margin-top: 4px;
    font-style: italic;
  }

  .process-files {
    list-style: none;
    margin: 4px 0 0 0;
    padding: 0;
    font-size: 12px;
  }

  .process-files li {
    color: var(--ch-foreground);
    opacity: 0.8;
    padding-left: 16px;
    position: relative;
  }

  .process-files li::before {
    content: "•";
    position: absolute;
    left: 4px;
  }

  .process-files .files-more {
    opacity: 0.6;
    font-style: italic;
  }

  .no-files {
    font-size: 12px;
    color: var(--ch-foreground);
    opacity: 0.5;
    font-style: italic;
    margin-top: 4px;
  }

  /* Warning button styling */
  .warning-button {
    --vscode-button-background: var(--ch-warning);
    --vscode-button-hoverBackground: var(--ch-warning-hover, #c27d00);
    --vscode-button-foreground: var(--ch-background);
  }

  /* Danger button styling */
  .danger-button {
    --vscode-button-background: var(--ch-danger);
    --vscode-button-hoverBackground: var(--ch-danger-hover, #c42b1c);
    --vscode-button-foreground: var(--ch-background);
  }
</style>
