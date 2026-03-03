<script lang="ts">
  import type { Snippet } from "svelte";
  import { createFocusTrap } from "$lib/utils/focus-trap";
  import { createLogger } from "$lib/logging";

  const logger = createLogger("ui");

  interface DialogProps {
    open: boolean;
    onClose: () => void;
    busy?: boolean;
    title?: Snippet;
    content?: Snippet;
    actions?: Snippet;
    titleId: string;
    descriptionId?: string;
    /** Optional selector for initial focus element. If not provided, focuses first focusable. */
    initialFocusSelector?: string;
  }

  let {
    open,
    onClose,
    busy = false,
    title,
    content,
    actions,
    titleId,
    descriptionId,
    initialFocusSelector,
  }: DialogProps = $props();

  let dialogElement: HTMLDivElement | undefined = $state();

  // Set up focus trap and initial focus when dialog opens
  $effect(() => {
    if (!open || !dialogElement) return;

    const trap = createFocusTrap(dialogElement);
    trap.activate();
    logger.debug("Focus trap activated", { activated: true });

    // Delay focus to allow web components to initialize
    const focusTimeout = setTimeout(() => {
      if (initialFocusSelector) {
        trap.focusSelector(initialFocusSelector);
      } else {
        trap.focusFirst();
      }
    }, 0);

    return () => {
      clearTimeout(focusTimeout);
      trap.deactivate();
      logger.debug("Focus trap activated", { activated: false });
      // Focus is handled by MainView's $effect when dialog closes
    };
  });

  // Handle Escape key
  $effect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        if (busy) return;
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  });
</script>

{#if open}
  <div class="dialog-overlay" data-testid="dialog-overlay" role="presentation">
    <div
      bind:this={dialogElement}
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy || undefined}
      tabindex="-1"
    >
      {#if title}
        <div class="dialog-title">
          {@render title()}
        </div>
      {/if}

      {#if content}
        <div class="dialog-content">
          {@render content()}
        </div>
      {/if}

      {#if actions}
        <div class="dialog-actions">
          {@render actions()}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: var(--ch-overlay-bg);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .dialog {
    background: var(--ch-background);
    color: var(--ch-foreground);
    border: 1px solid var(--ch-input-border);
    border-radius: 4px;
    padding: 16px;
    max-width: var(--ch-dialog-max-width, 450px);
    width: 90%;
    max-height: 90vh;
    overflow-y: auto;
  }

  .dialog-title {
    margin-bottom: 12px;
  }

  .dialog-content {
    margin-bottom: 16px;
  }

  .dialog-actions {
    display: flex;
    flex-direction: row-reverse;
    justify-content: flex-start;
    gap: 8px;
  }
</style>
