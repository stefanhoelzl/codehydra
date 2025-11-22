<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { listenSetupProgress, setupRuntime } from '$lib/api/tauri';
  import type { SetupEvent, StepStatus, StepState } from '$lib/types/setup';

  interface Props {
    /** Whether the setup modal is visible. */
    visible?: boolean;
    /** Callback when setup completes successfully. */
    onComplete?: () => void;
  }

  let { visible = true, onComplete = () => {} }: Props = $props();

  // UI state - mirrors what backend sends
  let steps = $state<StepStatus[]>([]);
  let statusMessage = $state('Initializing...');
  let errorMessage = $state<string | null>(null);
  let isRunning = $state(false);

  // Unlisten function for cleanup
  let unlisten: (() => void) | null = null;

  // Get icon for step state
  function getStepIcon(state: StepState): string {
    switch (state) {
      case 'pending':
        return '\u25CB'; // ○
      case 'inProgress':
        return '\u25CF'; // ●
      case 'completed':
        return '\u2713'; // ✓
      case 'failed':
        return '\u2717'; // ✗
    }
  }

  // Get CSS class for step state
  function getStepClass(state: StepState): string {
    return `step-${state}`;
  }

  // Handle setup events from backend
  function handleEvent(event: SetupEvent) {
    switch (event.type) {
      case 'update':
        statusMessage = event.message;
        steps = event.steps;
        break;

      case 'complete':
        isRunning = false;
        // Call onComplete callback after a brief delay to show success state
        setTimeout(() => {
          onComplete();
        }, 500);
        break;

      case 'failed':
        errorMessage = event.error;
        statusMessage = 'Setup failed!';
        isRunning = false;
        break;
    }
  }

  // Start the setup process
  async function startSetup() {
    // Reset state
    errorMessage = null;
    isRunning = true;
    steps = [];
    statusMessage = 'Starting setup...';

    try {
      // Start listening for events
      unlisten = await listenSetupProgress(handleEvent);

      // Start the setup process
      await setupRuntime();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      statusMessage = 'Setup failed!';
      isRunning = false;
    }
  }

  // Retry setup after failure
  function retry() {
    startSetup();
  }

  onMount(() => {
    // Start setup automatically when modal is shown
    startSetup();
  });

  onDestroy(() => {
    // Clean up event listener
    if (unlisten) {
      unlisten();
    }
  });
</script>

{#if visible}
  <div class="modal-overlay">
    <div class="modal-content">
      <h1>Setting up Chime</h1>

      <div class="status">
        <p class="caption">{statusMessage}</p>

        {#if isRunning}
          <div class="progress-bar-container">
            <div class="progress-bar"></div>
          </div>
        {/if}
      </div>

      <div class="steps">
        {#each steps as step (step.label)}
          <div class="step {getStepClass(step.state)}">
            <span class="step-icon">{getStepIcon(step.state)}</span>
            <span class="step-label">{step.label}</span>
          </div>
        {/each}
      </div>

      {#if errorMessage}
        <div class="error">
          <p class="error-message">{errorMessage}</p>
          <button class="retry-button" onclick={retry} disabled={isRunning}> Retry </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal-content {
    background: var(--vscode-editor-background, #1e1e1e);
    border: 1px solid var(--vscode-panel-border, #454545);
    border-radius: 8px;
    padding: 32px;
    min-width: 400px;
    max-width: 500px;
    text-align: center;
  }

  h1 {
    margin: 0 0 24px 0;
    font-size: 20px;
    font-weight: 500;
    color: var(--vscode-editor-foreground, #d4d4d4);
  }

  .status {
    margin-bottom: 24px;
  }

  .caption {
    margin: 0 0 12px 0;
    font-size: 14px;
    color: var(--vscode-descriptionForeground, #888);
  }

  .progress-bar-container {
    width: 100%;
    height: 4px;
    background: var(--vscode-progressBar-background, #333);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    width: 30%;
    background: var(--vscode-progressBar-foreground, #0078d4);
    animation: indeterminate 1.5s ease-in-out infinite;
  }

  @keyframes indeterminate {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(333%);
    }
  }

  .steps {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 24px;
  }

  .step {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 14px;
    padding: 8px 12px;
    border-radius: 4px;
    background: var(--vscode-input-background, #3c3c3c);
  }

  .step-icon {
    font-size: 16px;
    width: 20px;
    text-align: center;
  }

  .step-label {
    flex: 1;
    text-align: left;
  }

  .step-pending {
    color: var(--vscode-disabledForeground, #666);
  }

  .step-pending .step-icon {
    color: var(--vscode-disabledForeground, #666);
  }

  .step-inProgress {
    color: var(--vscode-editor-foreground, #d4d4d4);
  }

  .step-inProgress .step-icon {
    color: var(--vscode-progressBar-foreground, #0078d4);
    animation: pulse 1s ease-in-out infinite;
  }

  .step-completed {
    color: var(--vscode-editor-foreground, #d4d4d4);
  }

  .step-completed .step-icon {
    color: var(--vscode-testing-iconPassed, #73c991);
  }

  .step-failed {
    color: var(--vscode-editor-foreground, #d4d4d4);
  }

  .step-failed .step-icon {
    color: var(--vscode-testing-iconFailed, #f14c4c);
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }

  .error {
    margin-top: 24px;
    padding: 16px;
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    border-radius: 4px;
  }

  .error-message {
    margin: 0 0 12px 0;
    font-size: 13px;
    color: var(--vscode-inputValidation-errorForeground, #f14c4c);
    word-break: break-word;
  }

  .retry-button {
    background: var(--vscode-button-background, #0078d4);
    color: var(--vscode-button-foreground, #fff);
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.2s;
  }

  .retry-button:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground, #026ec1);
  }

  .retry-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
