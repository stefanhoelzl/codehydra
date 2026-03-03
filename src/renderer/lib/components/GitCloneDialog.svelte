<script lang="ts">
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";
  import { on, projects } from "$lib/api";
  import { openCreateDialog } from "$lib/stores/dialogs.svelte.js";
  import { createLogger } from "$lib/logging";
  import { getErrorMessage } from "@shared/error-utils";
  import type { CloneProgress } from "@shared/api/types";

  const logger = createLogger("ui");

  interface GitCloneDialogProps {
    open: boolean;
  }

  let { open }: GitCloneDialogProps = $props();

  // Form state
  let url = $state("");
  let submitError = $state<string | null>(null);
  let isCloning = $state(false);

  // Clone progress state
  let cloneStage = $state<string | null>(null);
  let cloneProgress = $state(0);

  function stageLabel(stage: string): string {
    switch (stage) {
      case "receiving":
        return "Receiving objects...";
      case "resolving":
        return "Resolving deltas...";
      case "counting":
        return "Counting objects...";
      case "compressing":
        return "Compressing objects...";
      default:
        return stage.charAt(0).toUpperCase() + stage.slice(1) + "...";
    }
  }

  // Subscribe to clone progress events
  $effect(() => {
    const unsub = on<CloneProgress>("project:clone-progress", (payload: CloneProgress) => {
      cloneStage = payload.stage;
      cloneProgress = payload.progress;
    });
    return () => {
      unsub();
    };
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
  async function handleSubmit(): Promise<void> {
    if (isCloning || isCloneDisabled) return;

    submitError = null;
    isCloning = true;
    cloneStage = null;
    cloneProgress = 0;

    logger.debug("Cloning repository", { url });

    try {
      const project = await projects.clone(url.trim());
      logger.info("Repository cloned successfully", { projectId: project.id });
      // Return to CreateWorkspaceDialog with the new project selected
      openCreateDialog(project.id);
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("Clone failed", { url, error: message });
      submitError = message;
      isCloning = false;
    }
  }

  // Handle cancel
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
      void handleSubmit();
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

    {#if isCloning && cloneStage !== null}
      <div class="clone-progress" aria-live="polite">
        <div class="clone-progress-header">
          <span class="clone-progress-stage">{stageLabel(cloneStage)}</span>
          <span class="clone-progress-pct">{cloneProgress}%</span>
        </div>
        <vscode-progress-bar
          value={cloneProgress}
          aria-label="Clone progress"
          aria-valuenow={cloneProgress}
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
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <vscode-button onclick={handleSubmit} disabled={isCloneDisabled} class="clone-button">
      {#if isCloning}
        <vscode-progress-ring class="button-spinner"></vscode-progress-ring>
        <span id={descriptionId}>Cloning...</span>
      {:else}
        Clone
      {/if}
    </vscode-button>
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

  /* Make the spinner smaller to fit in the button */
  :global(.button-spinner) {
    width: 14px;
    height: 14px;
  }
</style>
