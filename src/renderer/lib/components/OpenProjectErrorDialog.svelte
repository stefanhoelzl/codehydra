<script lang="ts">
  import Dialog from "./Dialog.svelte";

  interface OpenProjectErrorDialogProps {
    open: boolean;
    errorMessage: string;
    onRetry: () => void;
    onClose: () => void;
  }

  let { open, errorMessage, onRetry, onClose }: OpenProjectErrorDialogProps = $props();

  // IDs for accessibility
  const titleId = "open-project-error-title";
  const descriptionId = "open-project-error-desc";
</script>

<Dialog
  {open}
  {onClose}
  busy={false}
  {titleId}
  {descriptionId}
  initialFocusSelector="vscode-button"
>
  {#snippet title()}
    <h2 id={titleId} class="ch-dialog-title">Could Not Open Project</h2>
  {/snippet}

  {#snippet content()}
    <div id={descriptionId} class="ch-alert-box" role="alert">
      {errorMessage}
    </div>
  {/snippet}

  {#snippet actions()}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <vscode-button onclick={onRetry}>Select Different Folder</vscode-button>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <vscode-button secondary={true} onclick={onClose}>Cancel</vscode-button>
  {/snippet}
</Dialog>

<style>
  /* All styles moved to shared variables.css (.ch-dialog-title, .ch-alert-box) */
</style>
