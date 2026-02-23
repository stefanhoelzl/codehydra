<script lang="ts">
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";
  import { projects as projectsApi, workspaces } from "$lib/api";
  import { closeDialog } from "$lib/stores/dialogs.svelte.js";
  import { projects } from "$lib/stores/projects.svelte.js";
  import { createLogger } from "$lib/logging";
  import { getErrorMessage } from "@shared/error-utils";
  import type { ProjectId } from "@shared/api/types";

  const logger = createLogger("ui");

  interface CloseProjectDialogProps {
    open: boolean;
    projectId: ProjectId;
  }

  let { open, projectId }: CloseProjectDialogProps = $props();

  // Form state
  let removeAll = $state(false);
  let keepLocalRepo = $state(false);
  let submitError = $state<string | null>(null);
  let isSubmitting = $state(false);

  // Derive project from store (reactive - handles project removal elsewhere)
  const project = $derived(projects.value.find((p) => p.id === projectId));
  const workspaceCount = $derived(project?.workspaces.length ?? 0);
  const workspaceText = $derived(
    workspaceCount === 1 ? "1 workspace" : `${workspaceCount} workspaces`
  );
  const isRemoteProject = $derived(Boolean(project?.remoteUrl));
  const shouldDeleteRepo = $derived(isRemoteProject && !keepLocalRepo);

  // Dynamic button label
  const buttonLabel = $derived.by(() => {
    if (isSubmitting) return "Closing...";
    if (shouldDeleteRepo) return "Delete & Close";
    if (removeAll) return "Remove & Close";
    return "Close Project";
  });

  // Handle form submission
  async function handleSubmit(): Promise<void> {
    if (isSubmitting) return;

    submitError = null;
    isSubmitting = true;

    logger.debug("Dialog submitted", { type: "close-project" });

    try {
      // If removeAll or shouldDeleteRepo, remove all workspaces first
      if ((shouldDeleteRepo || removeAll) && project && project.workspaces.length > 0) {
        const removalPromises = project.workspaces.map((workspace) =>
          workspaces
            .remove(workspace.path, { keepBranch: false })
            .then(() => ({ name: workspace.name, success: true as const }))
            .catch((error: Error) => ({
              name: workspace.name,
              success: false as const,
              error: error.message,
            }))
        );

        // Use Promise.allSettled pattern (map returns results)
        const results = await Promise.all(removalPromises);

        // Check for failures
        const failures = results.filter((r) => !r.success) as Array<{
          name: string;
          success: false;
          error: string;
        }>;
        const successCount = results.length - failures.length;

        if (failures.length > 0) {
          const failureList = failures.map((f) => `• ${f.name}: ${f.error}`).join("\n");
          submitError = `Removed ${successCount} of ${results.length} workspaces. Failed:\n${failureList}`;
        }
      }

      // Always close the project (even if some removals failed)
      // Pass removeLocalRepo option if checked (and project is remote)
      await projectsApi.close(
        project!.path,
        shouldDeleteRepo ? { removeLocalRepo: true } : undefined
      );
      closeDialog();
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("UI error", { component: "CloseProjectDialog", error: message });
      submitError = message;
      isSubmitting = false;
    }
  }

  // Handle cancel
  function handleCancel(): void {
    logger.debug("Dialog closed", { type: "close-project" });
    closeDialog();
  }

  // Handle checkbox change - vscode-checkbox exposes checked property
  function handleRemoveAllChange(event: Event): void {
    removeAll = (event.target as unknown as { checked: boolean }).checked;
  }

  // Handle keep local repo checkbox change
  function handleKeepLocalRepoChange(event: Event): void {
    const checked = (event.target as unknown as { checked: boolean }).checked;
    keepLocalRepo = checked;
    // When "Keep" is checked, unlock the workspace checkbox (uncheck removeAll)
    if (checked) {
      removeAll = false;
    }
  }

  // IDs for accessibility
  const titleId = "close-project-title";
  const descriptionId = "close-project-desc";
</script>

<Dialog
  {open}
  onClose={handleCancel}
  busy={isSubmitting}
  {titleId}
  {descriptionId}
  initialFocusSelector="vscode-button"
>
  {#snippet title()}
    <h2 id={titleId} class="ch-dialog-title">Close Project</h2>
  {/snippet}

  {#snippet content()}
    {#if workspaceCount > 0}
      <p id={descriptionId} class="ch-dialog-text">
        This project has {workspaceText} that will remain on disk after closing.
      </p>

      <div class="ch-checkbox-row">
        <vscode-checkbox
          checked={shouldDeleteRepo || removeAll}
          onchange={handleRemoveAllChange}
          disabled={isSubmitting || shouldDeleteRepo}
          label="Remove all workspaces and their branches"
        ></vscode-checkbox>
      </div>
    {/if}

    {#if isRemoteProject}
      <div class="ch-checkbox-row">
        <vscode-checkbox
          checked={keepLocalRepo}
          onchange={handleKeepLocalRepoChange}
          disabled={isSubmitting}
          label="Keep cloned repository"
        ></vscode-checkbox>
      </div>

      {#if shouldDeleteRepo}
        <div class="ch-alert-box warning" role="alert">
          <span class="ch-alert-box-icon" aria-hidden="true">
            <Icon name="warning" />
          </span>
          <span class="warning-text">
            This will permanently delete the cloned repository and all workspaces. You can clone it
            again from: {project?.remoteUrl}
          </span>
        </div>
      {/if}
    {/if}

    {#if submitError}
      <div class="ch-alert-box" role="alert">
        <span class="ch-alert-box-icon" aria-hidden="true">
          <Icon name="warning" />
        </span>
        <span class="error-text">{submitError}</span>
      </div>
    {/if}
  {/snippet}

  {#snippet actions()}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <vscode-button onclick={handleSubmit} disabled={isSubmitting}>
      {buttonLabel}
    </vscode-button>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <vscode-button secondary={true} onclick={handleCancel} disabled={isSubmitting}>
      Cancel
    </vscode-button>
  {/snippet}
</Dialog>

<style>
  /* Component-specific styles only - shared styles in variables.css */
  .error-text {
    white-space: pre-line;
  }

  .warning-text {
    word-break: break-word;
  }

  .ch-alert-box.warning {
    margin-top: var(--ch-spacing-md);
  }
</style>
