<script lang="ts">
  import { onMount } from "svelte";

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

  let retryButtonRef: HTMLButtonElement | undefined = $state();

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
  <div class="error-content" role="alert">
    <h1>Setup Failed</h1>
    <p class="error-description">Failed to install VSCode extensions.</p>
    <p class="error-hint">Please check your internet connection.</p>
    <p class="error-details">Error: {errorMessage}</p>
  </div>

  <div class="button-group">
    <button bind:this={retryButtonRef} class="button button--primary" onclick={() => onretry?.()}>
      Retry
    </button>
    <button class="button button--secondary" onclick={() => onquit?.()}> Quit </button>
  </div>
</div>

<style>
  .setup-error {
    display: contents;
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

  .button {
    padding: 0.5rem 1.5rem;
    border: none;
    border-radius: 4px;
    font-size: 0.875rem;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .button--primary {
    background-color: var(--ch-button-bg);
    color: var(--ch-foreground);
  }

  .button--primary:hover {
    background-color: var(--ch-button-hover-bg, var(--ch-button-bg));
    filter: brightness(1.2);
  }

  .button--primary:focus {
    outline: 2px solid var(--ch-focus-border);
    outline-offset: 2px;
  }

  .button--secondary {
    background-color: transparent;
    color: var(--ch-foreground);
    border: 1px solid var(--ch-border);
  }

  .button--secondary:hover {
    background-color: var(--ch-input-bg);
  }

  .button--secondary:focus {
    outline: 2px solid var(--ch-focus-border);
    outline-offset: 2px;
  }
</style>
