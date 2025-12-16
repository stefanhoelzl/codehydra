<script lang="ts">
  import { onMount } from "svelte";
  import Logo from "./Logo.svelte";

  /**
   * Error screen component displayed when first-run setup fails.
   * Shows error message with Retry and Quit buttons.
   */
  interface Props {
    errorMessage: string;
    onretry?: () => void;
    onquit?: () => void;
  }

  let { errorMessage, onretry, onquit }: Props = $props();

  let retryButtonRef: HTMLElement | undefined = $state();

  onMount(() => {
    // Auto-focus Retry button when error screen appears
    retryButtonRef?.focus();

    // Handle Escape key for quit
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onquit?.();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  });
</script>

<div class="setup-error">
  <Logo animated={false} />
  <div class="error-content" role="alert">
    <h1>Setup Failed</h1>
    <p class="error-description">Failed to install VSCode extensions.</p>
    <p class="error-hint">Please check your internet connection.</p>
    <p class="error-details">Error: {errorMessage}</p>
  </div>

  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="button-group">
    <vscode-button bind:this={retryButtonRef} onclick={() => onretry?.()}>Retry</vscode-button>
    <vscode-button secondary={true} onclick={() => onquit?.()}>Quit</vscode-button>
  </div>
</div>

<style>
  .setup-error {
    display: contents;
  }

  .setup-error :global(img) {
    margin-bottom: 1rem;
  }

  .error-content {
    text-align: center;
    margin-bottom: 2rem;
  }

  h1 {
    margin: 0 0 1rem;
    font-size: 1.5rem;
    font-weight: 500;
    color: var(--ch-danger, #f14c4c);
  }

  .error-description {
    margin: 0 0 0.5rem;
    font-size: 0.875rem;
  }

  .error-hint {
    margin: 0 0 1rem;
    font-size: 0.875rem;
    opacity: 0.8;
  }

  .error-details {
    margin: 0;
    font-size: 0.75rem;
    font-family: monospace;
    opacity: 0.7;
    max-width: 400px;
    word-break: break-word;
  }

  .button-group {
    display: flex;
    gap: 1rem;
  }
</style>
