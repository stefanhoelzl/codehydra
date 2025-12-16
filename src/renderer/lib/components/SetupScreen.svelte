<script lang="ts">
  /**
   * Setup screen component displayed during first-run setup.
   * Shows an indeterminate progress bar with current step message.
   */
  import Logo from "./Logo.svelte";

  interface Props {
    currentStep: string;
  }

  let { currentStep }: Props = $props();
</script>

<div class="setup-screen">
  <Logo animated={true} />
  <h1>Setting up VSCode...</h1>
  <p class="step-message" aria-live="polite">{currentStep}</p>
  <vscode-progress-bar class="progress-bar" indeterminate={true} aria-label="Setting up VSCode"
  ></vscode-progress-bar>
</div>

<style>
  .setup-screen {
    display: contents;
  }

  .setup-screen :global(img) {
    margin-bottom: 2rem;
  }

  h1 {
    margin: 0 0 1rem;
    font-size: 1.5rem;
    font-weight: 500;
  }

  .step-message {
    margin: 0 0 2rem;
    font-size: 0.875rem;
    opacity: 0.8;
  }

  .progress-bar {
    width: 250px;
  }
</style>
