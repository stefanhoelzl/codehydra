<script lang="ts">
  /**
   * Setup screen component displayed during first-run setup.
   * Shows a 3-row layout for VSCode, Agent, and Setup progress.
   * Shows Retry/Quit buttons when setup fails.
   */
  import Logo from "./Logo.svelte";
  import Icon from "./Icon.svelte";
  import type {
    SetupRowId,
    SetupRowStatus,
    SetupRowProgress,
    ConfigAgentType,
  } from "@shared/api/types";

  interface Props {
    /** Main heading message (default: "Setting up CodeHydra") */
    message?: string;
    /** Subtitle message (default: "This is only required on first startup.") */
    subtitle?: string;
    /** Selected agent type (affects row label) */
    agent?: ConfigAgentType | null;
    /** Progress for each row (optional - uses defaults if not provided) */
    progress?: readonly SetupRowProgress[];
    /** Hide progress rows entirely (for loading states) */
    hideProgress?: boolean;
    /** Callback when Retry button is clicked (shown on failure) */
    onretry?: () => void;
    /** Callback when Quit button is clicked (shown on failure) */
    onquit?: () => void;
  }

  let {
    message = "Setting up CodeHydra",
    subtitle = "This is only required on first startup.",
    agent = null,
    progress,
    hideProgress = false,
    onretry,
    onquit,
  }: Props = $props();

  /** Default progress state for all rows (pending) */
  const defaultProgress: readonly SetupRowProgress[] = [
    { id: "vscode", status: "pending" },
    { id: "agent", status: "pending" },
    { id: "setup", status: "pending" },
  ];

  /** Get the current progress state (provided or default when undefined/empty) */
  const currentProgress = $derived(progress && progress.length > 0 ? progress : defaultProgress);

  /** Get row by ID */
  function getRow(id: SetupRowId): SetupRowProgress {
    const row = currentProgress.find((r) => r.id === id);
    return row ?? { id, status: "pending" };
  }

  /** Get icon name for a row status */
  function getStatusIcon(status: SetupRowStatus): string {
    switch (status) {
      case "pending":
        return "circle-outline";
      case "running":
        return "sync";
      case "done":
        return "check";
      case "failed":
        return "error";
      default:
        return "circle-outline";
    }
  }

  /** Get icon color class for a row status */
  function getStatusClass(status: SetupRowStatus): string {
    switch (status) {
      case "done":
        return "status-done";
      case "failed":
        return "status-failed";
      default:
        return "";
    }
  }

  /** Get display label for a row */
  function getRowLabel(id: SetupRowId): string {
    switch (id) {
      case "vscode":
        return "VSCode";
      case "agent":
        // Show agent name if selected, otherwise generic
        return agent === "claude" ? "Claude" : agent === "opencode" ? "OpenCode" : "Agent";
      case "setup":
        return "Setup";
      default:
        return id;
    }
  }

  /** Get status message for a row */
  function getStatusMessage(row: SetupRowProgress): string {
    if (row.message) {
      return row.message;
    }
    switch (row.status) {
      case "pending":
        return "";
      case "running":
        return row.progress !== undefined ? `Downloading ${row.progress}%` : "Downloading...";
      case "done":
        return "Complete";
      case "failed":
        return row.error ?? "Failed";
      default:
        return "";
    }
  }

  /** Calculate progress bar value (0-100, or -1 for indeterminate) */
  function getProgressValue(row: SetupRowProgress): number {
    switch (row.status) {
      case "pending":
        return 0;
      case "running":
        return row.progress ?? -1; // -1 means indeterminate
      case "done":
        return 100;
      case "failed":
        return row.progress ?? 0;
      default:
        return 0;
    }
  }

  /** Check if progress bar should be indeterminate */
  function isIndeterminate(row: SetupRowProgress): boolean {
    return row.status === "running" && row.progress === undefined;
  }

  /** Row IDs in display order */
  const rowIds: readonly SetupRowId[] = ["vscode", "agent", "setup"];

  /** Check if any row has failed */
  const hasFailedRow = $derived(currentProgress.some((row) => row.status === "failed"));
</script>

<div class="setup-screen">
  <Logo animated={true} />
  <h1>{message}</h1>
  {#if subtitle}
    <p class="subtitle">{subtitle}</p>
  {/if}
  <p class="hint">
    Tip: <vscode-badge>Alt+X</vscode-badge> for keyboard shortcuts
  </p>

  {#if !hideProgress}
    <div class="progress-container" role="status" aria-live="polite" aria-atomic="false">
      {#each rowIds as id, index (id)}
        {@const row = getRow(id)}
        {@const progressValue = getProgressValue(row)}
        <div class="row" class:row-failed={row.status === "failed"}>
          <div class="row-header">
            <div class="row-status {getStatusClass(row.status)}">
              <Icon name={getStatusIcon(row.status)} spin={row.status === "running"} />
            </div>
            <span class="row-label">{getRowLabel(id)}</span>
            <span class="row-message">{getStatusMessage(row)}</span>
          </div>
          <div class="row-progress">
            {#if isIndeterminate(row)}
              <vscode-progress-bar indeterminate={true} aria-label="{getRowLabel(id)} progress"
              ></vscode-progress-bar>
            {:else}
              <vscode-progress-bar
                value={progressValue}
                aria-label="{getRowLabel(id)} progress"
                aria-valuenow={progressValue}
                aria-valuemin="0"
                aria-valuemax="100"
              ></vscode-progress-bar>
            {/if}
          </div>
        </div>
        {#if index < rowIds.length - 1}
          <div class="row-divider"></div>
        {/if}
      {/each}
    </div>
  {/if}

  {#if hasFailedRow && (onretry || onquit)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="button-group">
      {#if onretry}
        <vscode-button onclick={onretry}>Retry</vscode-button>
      {/if}
      {#if onquit}
        <vscode-button secondary={true} onclick={onquit}>Quit</vscode-button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .setup-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 500;
  }

  .subtitle {
    margin: 0;
    font-size: 0.875rem;
    opacity: 0.8;
  }

  .hint {
    margin: 0;
    font-size: 0.875rem;
    opacity: 0.7;
  }

  .progress-container {
    display: flex;
    flex-direction: column;
    width: 400px;
    max-width: 100%;
    margin-top: 1rem;
    padding: 0.5rem;
    border: 1px solid var(--ch-border);
    border-radius: 8px;
    background: var(--ch-panel-background);
  }

  .row {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
  }

  .row-failed {
    background: color-mix(in srgb, var(--ch-error) 10%, transparent);
    border-radius: 4px;
  }

  .row-divider {
    height: 1px;
    margin: 0 0.75rem;
    background: var(--ch-border);
  }

  .row-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .row-status {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    opacity: 0.7;
  }

  .row-status.status-done {
    color: var(--ch-success, #89d185);
    opacity: 1;
  }

  .row-status.status-failed {
    color: var(--ch-error, #f14c4c);
    opacity: 1;
  }

  .row-label {
    font-weight: 500;
    flex-shrink: 0;
  }

  .row-message {
    margin-left: auto;
    font-size: 0.875rem;
    opacity: 0.7;
  }

  .row-progress {
    width: 100%;
    height: 4px;
    background: var(--ch-input-background, rgba(255, 255, 255, 0.1));
    border-radius: 2px;
    overflow: hidden;
  }

  .row-progress :global(vscode-progress-bar) {
    width: 100%;
    height: 100%;
  }

  .button-group {
    display: flex;
    gap: 1rem;
    margin-top: 1rem;
  }
</style>
