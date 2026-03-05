<script lang="ts">
  /**
   * UpdateOverlay - Shows update choice or download progress.
   *
   * Two states:
   * - "choice": Shows version info and 4 buttons (Always, Yes, Skip, Never)
   * - "downloading": Shows progress bar and Cancel button
   */
  import type { UpdateChoice } from "@shared/ipc";
  import Logo from "./Logo.svelte";

  interface Props {
    /** Current overlay mode */
    mode: "choice" | "downloading";
    /** Version being updated to */
    version: string;
    /** Download progress (0-100) */
    percent: number;
    /** Callback when user makes a choice */
    onchoice: (choice: UpdateChoice) => void;
    /** Callback when user cancels download */
    oncancel: () => void;
  }

  const { mode, version, percent, onchoice, oncancel }: Props = $props();
</script>

<div class="update-overlay" role="dialog" aria-label="Update available">
  <Logo size={64} />

  {#if mode === "choice"}
    <h1>Update Available</h1>
    <p class="subtitle">Version {version} is available.</p>
    <p class="info">The app will restart to update.</p>

    <div class="buttons">
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <vscode-button appearance="secondary" onclick={() => onchoice("always")}>
        Always
      </vscode-button>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <vscode-button onclick={() => onchoice("yes")}>Yes</vscode-button>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <vscode-button appearance="secondary" onclick={() => onchoice("skip")}> Skip </vscode-button>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <vscode-button appearance="secondary" onclick={() => onchoice("never")}>
        Never
      </vscode-button>
    </div>
  {:else}
    <h1>Updating CodeHydra</h1>
    <p class="subtitle">Downloading version {version}...</p>

    <div class="progress-container">
      <vscode-progress-ring class:hidden={percent > 0}></vscode-progress-ring>
      {#if percent > 0}
        <div
          class="progress-bar-wrapper"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div class="progress-bar-fill" style="width: {percent}%"></div>
        </div>
        <span class="progress-text">{Math.round(percent)}%</span>
      {/if}
    </div>

    <p class="info">The app will restart automatically.</p>

    <div class="buttons">
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <vscode-button appearance="secondary" onclick={oncancel}>Cancel</vscode-button>
    </div>
  {/if}
</div>

<style>
  .update-overlay {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    text-align: center;
    max-width: 400px;
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 500;
  }

  .subtitle {
    margin: 0;
    font-size: 0.875rem;
    opacity: 0.8;
  }

  .info {
    margin: 0;
    font-size: 0.8rem;
    opacity: 0.6;
  }

  .buttons {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .progress-container {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    margin: 0.5rem 0;
  }

  .progress-bar-wrapper {
    flex: 1;
    height: 4px;
    background: var(--ch-border);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-bar-fill {
    height: 100%;
    background: var(--ch-focus-border);
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .progress-text {
    font-size: 0.875rem;
    min-width: 3ch;
    text-align: right;
    opacity: 0.8;
  }

  .hidden {
    display: none;
  }
</style>
