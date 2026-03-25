<!--
  NotificationStack.svelte

  Renders notifications stacked at the bottom of the sidebar.
  Two modes: expanded (full cards) and collapsed (type icons only).
  Newest notifications appear on top.
-->
<script lang="ts">
  import Icon from "./Icon.svelte";
  import { sendNotificationEvent } from "$lib/api";
  import { notifications } from "$lib/stores/notification-store.svelte.js";
  import type { NotificationConfig } from "@shared/notification-types";
  import type { DialogAction } from "@shared/dialog-types";

  interface Props {
    isExpanded: boolean;
  }

  const { isExpanded }: Props = $props();

  // Newest on top: reverse the insertion order
  const entries = $derived([...notifications.value.values()].reverse());

  function handleDismiss(notificationId: string): void {
    sendNotificationEvent({ notificationId, actionId: "dismiss" });
  }

  function handleAction(notificationId: string, action: DialogAction): void {
    if (action.disabled || action.busy) return;
    sendNotificationEvent({ notificationId, actionId: action.id });
  }

  function progressPercent(config: NotificationConfig): number | null {
    if (typeof config.progress === "number") {
      return Math.round(config.progress * 100);
    }
    return null;
  }
</script>

{#if entries.length > 0}
  <div class="notification-stack" class:expanded={isExpanded}>
    {#each entries as entry (entry.notificationId)}
      {@const config = entry.config}
      {@const pct = progressPercent(config)}
      {#if isExpanded}
        <div class="notification-entry" role="status" aria-label={config.title}>
          <vscode-divider></vscode-divider>
          <div class="notification-row">
            <span class="notification-title" title={config.title}>{config.title}</span>
            {#if config.dismissible}
              <button
                type="button"
                class="dismiss-btn"
                aria-label="Dismiss"
                onclick={() => handleDismiss(entry.notificationId)}
              >
                <Icon name="close" size={14} />
              </button>
            {/if}
            <span class="notification-indicator" aria-hidden="true">
              {#if config.type === "spinner"}
                <vscode-progress-ring class="notification-spinner"></vscode-progress-ring>
              {:else}
                <Icon name={config.type} size={14} />
              {/if}
            </span>
          </div>
          {#if config.message}
            <div class="notification-detail">{config.message}</div>
          {/if}
          {#if config.progress !== undefined}
            <div class="notification-progress">
              {#if typeof config.progress === "number"}
                <div class="progress-row">
                  <div class="progress-bar">
                    <div class="progress-fill" style="width: {config.progress * 100}%"></div>
                  </div>
                  <span class="notification-pct">{pct}%</span>
                </div>
              {:else}
                <div class="progress-bar indeterminate">
                  <div class="progress-fill"></div>
                </div>
              {/if}
            </div>
          {/if}
          {#if config.actions && config.actions.length > 0}
            <div class="notification-actions">
              {#each config.actions as action (action.id)}
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <vscode-button
                  secondary={action.variant !== "primary" || undefined}
                  disabled={action.disabled || action.busy || undefined}
                  onclick={() => handleAction(entry.notificationId, action)}
                >
                  {action.busy ? (action.busyLabel ?? action.label) : action.label}
                </vscode-button>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <div class="notification-entry-minimized" role="status" aria-label={config.title}>
          {#if config.type === "spinner"}
            <vscode-progress-ring class="notification-spinner"></vscode-progress-ring>
          {:else}
            <Icon name={config.type} size={14} />
          {/if}
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .notification-stack {
    flex-shrink: 0;
  }

  .notification-stack.expanded {
    max-height: 280px;
    overflow-y: auto;
    min-width: var(--ch-sidebar-width, 250px);
  }

  /* Expanded notification entry */
  .notification-entry {
    padding: 0 0 8px 0;
    min-width: var(--ch-sidebar-width, 250px);
    flex-shrink: 0;
  }

  .notification-row {
    display: flex;
    align-items: center;
    padding: 8px 12px 0 calc(var(--ch-sidebar-minimized-width, 20px) + 8px);
    gap: 8px;
  }

  .notification-title {
    flex: 1;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .notification-indicator {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    opacity: 0.7;
  }

  .dismiss-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: var(--ch-foreground);
    cursor: pointer;
    padding: 2px;
    opacity: 0.5;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .dismiss-btn:hover {
    opacity: 1;
    background: var(--ch-list-hover-bg);
  }

  .notification-detail {
    padding: 2px 12px 0 calc(var(--ch-sidebar-minimized-width, 20px) + 8px);
    font-size: 11px;
    opacity: 0.5;
  }

  .notification-progress {
    padding: 4px 12px 0 calc(var(--ch-sidebar-minimized-width, 20px) + 8px);
  }

  .progress-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .notification-pct {
    font-size: 11px;
    opacity: 0.7;
    flex-shrink: 0;
  }

  .progress-bar {
    flex: 1;
    height: 4px;
    background: var(--ch-input-border, #3c3c3c);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--ch-focus-border, #007fd4);
    border-radius: 2px;
    transition: width 0.2s ease-out;
  }

  .progress-bar.indeterminate .progress-fill {
    width: 30%;
    animation: indeterminate 1.5s ease-in-out infinite;
  }

  @keyframes indeterminate {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(433%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .progress-fill {
      transition: none;
    }
    .progress-bar.indeterminate .progress-fill {
      animation: none;
      width: 100%;
      opacity: 0.5;
    }
  }

  .notification-actions {
    padding: 6px 12px 0 calc(var(--ch-sidebar-minimized-width, 20px) + 8px + 14px + 8px);
    display: flex;
    gap: 6px;
  }

  .notification-spinner {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }

  /* Collapsed notification entry */
  .notification-entry-minimized {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--ch-sidebar-minimized-width, 20px);
    min-height: 36px;
    padding: 4px;
    flex-shrink: 0;
    opacity: 0.7;
  }
</style>
