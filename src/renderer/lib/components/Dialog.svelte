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
      trap.focusSelector("vscode-button");
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
    backdrop-filter: var(--ch-overlay-blur, blur(8px));
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
    z-index: 1000;
    animation: ch-overlay-in 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes ch-overlay-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .dialog {
    background: var(--ch-surface-2, var(--ch-background));
    color: var(--ch-foreground);
    border: 1px solid var(--ch-border);
    border-radius: var(--ch-radius-lg, 14px);
    padding: 20px 24px;
    max-width: var(--ch-dialog-max-width, 480px);
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: var(--ch-shadow-dialog);
    animation: ch-dialog-in 350ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes ch-dialog-in {
    from {
      opacity: 0;
      transform: translateY(-12px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dialog-overlay {
      animation: none;
    }

    .dialog {
      animation: none;
    }
  }

  .dialog-title {
    margin-bottom: 14px;
  }

  .dialog-content {
    margin-bottom: 16px;
  }

  .dialog-actions {
    display: flex;
    flex-direction: row-reverse;
    justify-content: flex-start;
    gap: 8px;
    border-top: 1px solid var(--ch-border);
    padding-top: 16px;
  }
</style>
