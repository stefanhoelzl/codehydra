<!--
  ProgressSection.svelte

  Progress section leaf: a list of progress items with status indicators.
  style "bar" (default) shows a progress bar per running item (undefined
  progress = indeterminate); style "spinner" shows only the spinning status
  icon.
-->
<script lang="ts">
  import type { ProgressItem } from "@shared/dialog-types";
  import Icon from "../Icon.svelte";
  import type { ProgressSectionConfig } from "./types";

  interface Props {
    section: ProgressSectionConfig;
  }

  const { section }: Props = $props();

  /** Get icon name for a progress item status. */
  function getStatusIcon(status: ProgressItem["status"]): string {
    switch (status) {
      case "pending":
        return "circle-outline";
      case "running":
        return "sync";
      case "done":
        return "check";
      case "error":
        return "error";
    }
  }

  /** Get CSS class for a progress item status. */
  function getStatusClass(status: ProgressItem["status"]): string {
    switch (status) {
      case "done":
        return "status-done";
      case "error":
        return "status-error";
      default:
        return "";
    }
  }
</script>

<div class="progress-container" role="status" aria-live="polite" aria-atomic="false">
  {#each section.items as item, itemIndex (item.id)}
    <div class="progress-row" class:progress-row-error={item.status === "error"}>
      <div class="progress-row-header">
        <span class="progress-status {getStatusClass(item.status)}">
          <Icon name={getStatusIcon(item.status)} spin={item.status === "running"} />
        </span>
        <span class="progress-label">{item.label}</span>
        {#if item.message && item.status !== "error"}
          <span class="progress-message">{item.message}</span>
        {/if}
      </div>
      {#if item.message && item.status === "error"}
        <div class="progress-error-detail">{item.message}</div>
      {/if}
      {#if section.style !== "spinner"}
        <div class="progress-bar-track">
          {#if item.status === "running" && item.progress === undefined}
            <vscode-progress-bar indeterminate={true} aria-label="{item.label} progress"
            ></vscode-progress-bar>
          {:else}
            {@const value =
              item.status === "done" ? 100 : item.status === "pending" ? 0 : (item.progress ?? 0)}
            <vscode-progress-bar
              {value}
              aria-label="{item.label} progress"
              aria-valuenow={value}
              aria-valuemin="0"
              aria-valuemax="100"
            ></vscode-progress-bar>
          {/if}
        </div>
      {/if}
    </div>
    {#if itemIndex < section.items.length - 1}
      <div class="progress-divider"></div>
    {/if}
  {/each}
</div>

<style>
  .progress-container {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 400px;
    padding: 0.5rem;
    border-radius: var(--ch-radius-sm, 6px);
  }

  .progress-row {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
  }

  .progress-row-error {
    border-radius: var(--ch-radius-sm, 6px);
  }

  .progress-divider {
    height: 1px;
    margin: 0 0.75rem;
    background: var(--ch-border);
  }

  .progress-row-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .progress-status {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    opacity: 0.7;
  }

  .progress-status.status-done {
    --vscode-icon-foreground: var(--ch-success, #89d185);
    color: var(--ch-success, #89d185);
    opacity: 1;
  }

  .progress-status.status-error {
    --vscode-icon-foreground: var(--ch-danger, #f14c4c);
    color: var(--ch-danger, #f14c4c);
    opacity: 1;
  }

  .progress-label {
    font-weight: 500;
    flex-shrink: 0;
  }

  .progress-message {
    margin-left: auto;
    font-size: 0.875rem;
    opacity: 0.7;
  }

  .progress-error-detail {
    margin-left: 28px;
    font-size: 0.75rem;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--ch-danger, #f14c4c);
    opacity: 0.85;
    word-break: break-word;
  }

  .progress-bar-track {
    width: 100%;
    height: 4px;
    background: var(--ch-input-background, rgba(255, 255, 255, 0.1));
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-bar-track :global(vscode-progress-bar) {
    width: 100%;
    height: 100%;
  }
</style>
