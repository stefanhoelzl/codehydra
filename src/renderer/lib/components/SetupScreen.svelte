<script lang="ts">
  /**
   * Setup screen component displayed during first-run setup.
   * Shows an indeterminate progress bar with current step message.
   */
  interface Props {
    currentStep: string;
  }

  let { currentStep }: Props = $props();
</script>

<div class="setup-screen">
  <h1>Setting up VSCode...</h1>
  <p class="step-message" aria-live="polite">{currentStep}</p>
  <div
    class="progress-bar"
    role="progressbar"
    aria-busy="true"
    aria-label="Setting up VSCode"
    aria-live="polite"
  >
    <div class="progress-bar__track"></div>
  </div>
</div>

<style>
  .setup-screen {
    display: contents;
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
    height: 4px;
    background-color: var(--ch-input-bg);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-bar__track {
    height: 100%;
    width: 30%;
    background-color: var(--ch-button-bg);
    animation: progress-indeterminate 1.5s ease-in-out infinite;
  }

  @keyframes progress-indeterminate {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(400%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .progress-bar__track {
      animation: none;
      width: 100%;
      opacity: 0.6;
    }
  }
</style>
