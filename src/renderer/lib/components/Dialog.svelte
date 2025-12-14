<script lang="ts">
  import type { Snippet } from "svelte";
  import { tick } from "svelte";
  import { createFocusTrap } from "$lib/utils/focus-trap";

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

    // Wait for DOM to update with snippet content before focusing
    void tick().then(() => {
      trap.focusFirst();
    });

    return () => {
      trap.deactivate();
      // Focus is handled by MainView's $effect when dialog closes
    };
  });

  // Handle Escape key
  $effect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  });

  function handleOverlayClick(): void {
    onClose();
  }

  function handleDialogClick(event: MouseEvent): void {
    event.stopPropagation();
  }
</script>

{#if open}
  <div
    class="dialog-overlay"
    data-testid="dialog-overlay"
    role="presentation"
    onclick={handleOverlayClick}
    onkeydown={() => {}}
  >
    <div
      bind:this={dialogElement}
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy || undefined}
      tabindex="-1"
      onclick={handleDialogClick}
      onkeydown={() => {}}
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
