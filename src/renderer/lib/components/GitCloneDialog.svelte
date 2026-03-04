<script lang="ts">
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";
  import { projects } from "$lib/api";
  import { openCreateDialog, closeDialog } from "$lib/stores/dialogs.svelte.js";
  import {
    cloneState,
    startClone,
    completeClone,
    stageLabel,
  } from "$lib/stores/clone-progress.svelte.js";
  import { createLogger } from "$lib/logging";
  import { getErrorMessage } from "@shared/error-utils";

  const logger = createLogger("ui");

  interface GitCloneDialogProps {
    open: boolean;
  }

  let { open }: GitCloneDialogProps = $props();

  // Form state
  let url = $state("");
  let submitError = $state<string | null>(null);

  // Whether this dialog instance started the clone (vs opening while one is in progress)
  let dialogOwnsClone = $state(false);

  // Clone is in progress (either started by this dialog or already running)
  const isCloning = $derived(cloneState.value !== null);

  // Read progress from store
  const currentStage = $derived(cloneState.value?.stage ?? null);
  const currentProgress = $derived(cloneState.value?.progress ?? 0);
  const progressPercent = $derived(Math.round(currentProgress * 100));

  // On open, pre-fill from existing clone state if applicable.
  // Uses a flag to run only once per dialog open (avoids re-running when
  // startClone() changes cloneState.value, which would reset dialogOwnsClone).
  let initialized = false;
  $effect(() => {
    if (!open) {
      initialized = false;
      return;
    }
    if (initialized) return;
    initialized = true;
    const state = cloneState.value;
    if (state) {
      // Clone already in progress — show progress
      url = state.url;
      dialogOwnsClone = false;
    }
  });

  // URL validation state
  // Validates full URLs and shorthand formats (org/repo, github.com/org/repo)
  const urlValidationError = $derived(() => {
    if (!url.trim()) return null;
    const trimmed = url.trim();

    // Full URL formats (HTTPS, HTTP, SSH, git://, ssh://)
    if (/^https?:\/\/[^\s]+/.test(trimmed)) return null;
    if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[^\s]+/.test(trimmed)) return null;
    if (/^git:\/\/[^\s]+/.test(trimmed)) return null;
    if (/^ssh:\/\/[^\s]+/.test(trimmed)) return null;

    // Shorthand: org/repo (GitHub shorthand - no dots in first segment)
    if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed)) return null;

    // Partial URL: github.com/org/repo (domain without protocol)
    if (/^[a-z0-9.-]+\/[^\s]+$/i.test(trimmed) && trimmed.includes(".")) return null;

    return "Enter a git URL, org/repo, or github.com/org/repo";
  });

  // Clone button disabled state
  const isCloneDisabled = $derived(!url.trim() || urlValidationError() !== null || isCloning);

  // Handle form submission
  function handleSubmit(): void {
    if (isCloning || isCloneDisabled) return;

    submitError = null;
    dialogOwnsClone = true;

    const trimmedUrl = url.trim();
    logger.debug("Cloning repository", { url: trimmedUrl });

    startClone(trimmedUrl);

    // Fire clone as detached promise — dialog may close before it resolves
    void projects.clone(trimmedUrl).then(
      (project) => {
        logger.info("Repository cloned successfully", { projectId: project.id });
        completeClone();
        // Only navigate if this dialog instance owns the clone and is still open
        if (dialogOwnsClone) {
          openCreateDialog(project.id);
        }
      },
      (error: unknown) => {
        const message = getErrorMessage(error);
        logger.warn("Clone failed", { url: trimmedUrl, error: message });
        completeClone();
        // If dialog is still open, show error inline
        if (dialogOwnsClone) {
          submitError = message;
        }
      }
    );
  }

  // Handle "Continue in background" — close dialog, clone keeps running
  function handleContinueInBackground(): void {
    logger.debug("Clone continuing in background", { url });
    dialogOwnsClone = false;
    closeDialog();
  }

  // Handle cancel (only available when not cloning)
  function handleCancel(): void {
    logger.debug("Dialog closed", { type: "git-clone" });
    // Return to CreateWorkspaceDialog without selecting a project
    openCreateDialog();
  }

  // Handle URL input
  function handleUrlInput(event: Event): void {
    url = (event.target as HTMLInputElement).value;
    // Clear submit error when user types
    if (submitError) {
      submitError = null;
    }
  }

  // Handle Enter key in textfield
  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !isCloneDisabled) {
      event.preventDefault();
      handleSubmit();
    }
  }

  // IDs for accessibility
  const titleId = "git-clone-title";
  const descriptionId = "git-clone-status";
</script>

<Dialog
  {open}
  onClose={handleCancel}
  busy={isCloning}
  {titleId}
  {descriptionId}
  initialFocusSelector="vscode-textfield"
>
  {#snippet title()}
    <h2 id={titleId} class="ch-dialog-title">Clone from Git Repository</h2>
  {/snippet}

  {#snippet content()}
    <div class="ch-form-group">
      <label for="clone-url" class="ch-label">Repository URL</label>
      <!-- svelte-ignore a11y_autofocus, a11y_no_static_element_interactions -->
      <vscode-textfield
        id="clone-url"
        value={url}
        oninput={handleUrlInput}
        onkeydown={handleKeydown}
        placeholder="org/repo or https://github.com/org/repo.git"
        disabled={isCloning}
        autofocus
        class="ch-textfield-full"
      ></vscode-textfield>
      {#if urlValidationError() && url.trim()}
        <p class="ch-validation-error">{urlValidationError()}</p>
      {/if}
    </div>

    {#if isCloning && currentStage !== null}
      <div class="clone-progress" aria-live="polite">
        <div class="clone-progress-header">
          <span class="clone-progress-stage">{stageLabel(currentStage)}</span>
          <span class="clone-progress-pct">{progressPercent}%</span>
        </div>
        <vscode-progress-bar
          value={progressPercent}
          aria-label="Clone progress"
          aria-valuenow={progressPercent}
          aria-valuemin="0"
          aria-valuemax="100"
        ></vscode-progress-bar>
      </div>
    {/if}

    {#if submitError}
      <div class="ch-alert-box" role="alert">
        <span class="ch-alert-box-icon" aria-hidden="true">
          <Icon name="error" />
        </span>
        <span class="error-text">{submitError}</span>
      </div>
    {/if}
  {/snippet}

  {#snippet actions()}
    {#if isCloning}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <vscode-button onclick={handleContinueInBackground} class="clone-button">
        <span id={descriptionId}>Continue in background</span>
      </vscode-button>
    {:else}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <vscode-button onclick={handleSubmit} disabled={isCloneDisabled} class="clone-button">
        Clone
      </vscode-button>
    {/if}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <vscode-button secondary={true} onclick={handleCancel} disabled={isCloning}>
      Cancel
    </vscode-button>
  {/snippet}
</Dialog>

<style>
  .clone-progress {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 8px;
  }

  .clone-progress-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .clone-progress-stage,
  .clone-progress-pct {
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #888888);
    margin: 0;
  }

  .error-text {
    white-space: pre-line;
  }

  /* Style for clone button to have consistent layout */
  :global(.clone-button) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
</style>
