<script lang="ts">
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";
  import { projects } from "$lib/api";
  import { closeDialog } from "$lib/stores/dialogs.svelte.js";
  import {
    openNewWorkspaceView,
    setNewWorkspaceProject,
  } from "$lib/stores/new-workspace-view.svelte.js";
  import { createLogger } from "$lib/logging";
  import { getErrorMessage } from "@shared/error-utils";
  import { extractGitHubOwnerRepo, buildGitHubNewRepoUrl } from "@shared/github-utils";

  const logger = createLogger("ui");

  interface GitCloneDialogProps {
    open: boolean;
  }

  let { open }: GitCloneDialogProps = $props();

  // Form state
  let url = $state("");
  let submitError = $state<string | null>(null);

  // The URL this dialog instance submitted (null if not yet submitted)
  let cloneUrl = $state<string | null>(null);

  // Clone is in progress for this dialog's URL
  const isCloning = $derived(cloneUrl !== null);

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

  // GitHub-specific error state: non-null when clone failed and URL is a GitHub repo
  const gitHubInfo = $derived(submitError ? extractGitHubOwnerRepo(url.trim()) : null);

  // Handle form submission
  function handleSubmit(): void {
    if (isCloning || isCloneDisabled) return;

    submitError = null;

    const trimmedUrl = url.trim();

    logger.debug("Cloning repository", { url: trimmedUrl });

    cloneUrl = trimmedUrl;

    // Fire clone as detached promise — dialog may close before it resolves
    void projects.clone(trimmedUrl).then(
      (project) => {
        logger.info("Repository cloned successfully", { projectId: project.id });
        // Only navigate if this dialog instance owns the clone and is still open.
        // Select the cloned project in the New workspace view (no dialog re-open).
        if (cloneUrl === trimmedUrl) {
          setNewWorkspaceProject(project.id);
          openNewWorkspaceView(project.id);
          closeDialog();
        }
      },
      (error: unknown) => {
        const message = getErrorMessage(error);
        logger.warn("Clone failed", { url: trimmedUrl, error: message });
        // If dialog is still open and tracking this URL, show error inline
        if (cloneUrl === trimmedUrl) {
          submitError = message;
          cloneUrl = null;
        }
      }
    );
  }

  // Handle "Continue in background" — close dialog, clone keeps running
  function handleContinueInBackground(): void {
    logger.debug("Clone continuing in background", { url: cloneUrl });
    cloneUrl = null;
    closeDialog();
  }

  // Open GitHub new repo page with pre-filled owner and name
  function handleCreateOnGitHub(): void {
    if (!gitHubInfo) return;
    const createUrl = buildGitHubNewRepoUrl(gitHubInfo.owner, gitHubInfo.repo);
    logger.info("Opening GitHub repo creation", { url: createUrl });
    window.open(createUrl);
  }

  // Retry clone after creating repo on GitHub
  function handleRetryClone(): void {
    submitError = null;
    handleSubmit();
  }

  // Handle cancel (only available when not cloning)
  function handleCancel(): void {
    logger.debug("Dialog closed", { type: "git-clone" });
    // Return to the New workspace view without selecting a project.
    closeDialog();
    openNewWorkspaceView();
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

    {#if submitError && gitHubInfo}
      <div class="github-create-box" role="alert">
        <p class="github-create-message">
          {gitHubInfo.owner}/{gitHubInfo.repo} not found on GitHub.
        </p>
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <vscode-button onclick={handleCreateOnGitHub}>
          <Icon name="github" />
          Create on GitHub
        </vscode-button>
        <div class="ch-alert-box">
          <span class="ch-alert-box-icon" aria-hidden="true">
            <Icon name="warning" />
          </span>
          <span>Initialize with a README to enable cloning.</span>
        </div>
      </div>
    {:else if submitError}
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
    {:else if gitHubInfo}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <vscode-button onclick={handleRetryClone} class="clone-button"> Retry Clone </vscode-button>
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
  .error-text {
    white-space: pre-line;
  }

  /* Style for clone button to have consistent layout */
  :global(.clone-button) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .github-create-box {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .github-create-message {
    margin: 0;
    color: var(--ch-foreground);
  }
</style>
