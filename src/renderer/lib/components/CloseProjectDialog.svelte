<script lang="ts">
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";
  import { projects as projectsApi, workspaces } from "$lib/api";
  import { closeDialog } from "$lib/stores/dialogs.svelte.js";
  import { projects } from "$lib/stores/projects.svelte.js";
  import { createLogger } from "$lib/logging";
  import { getErrorMessage } from "$lib/utils/error-utils";
  import type { ProjectId } from "@shared/api/types";

  const logger = createLogger("ui");

  interface CloseProjectDialogProps {
    open: boolean;
    projectId: ProjectId;
  }

  let { open, projectId }: CloseProjectDialogProps = $props();

  // Form state
  let removeAll = $state(false);
  let submitError = $state<string | null>(null);
  let isSubmitting = $state(false);

  // Derive project from store (reactive - handles project removal elsewhere)
  const project = $derived(projects.value.find((p) => p.id === projectId));
  const workspaceCount = $derived(project?.workspaces.length ?? 0);
  const workspaceText = $derived(
    workspaceCount === 1 ? "1 workspace" : `${workspaceCount} workspaces`
  );

  // Dynamic button label
  const buttonLabel = $derived(
    isSubmitting ? "Closing..." : removeAll ? "Remove & Close" : "Close Project"
  );

  // Handle form submission
  async function handleSubmit(): Promise<void> {
    if (isSubmitting) return;

    submitError = null;
    isSubmitting = true;

    logger.debug("Dialog submitted", { type: "close-project" });

    try {
      // If removeAll is checked, remove all workspaces first
      if (removeAll && project && project.workspaces.length > 0) {
        const removalPromises = project.workspaces.map((workspace) =>
          workspaces
            .remove(projectId, workspace.name, false)
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
      await projectsApi.close(projectId);
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
  function handleCheckboxChange(event: Event): void {
    removeAll = (event.target as unknown as { checked: boolean }).checked;
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
    <p id={descriptionId}>
      This project has {workspaceText} that will remain on disk after closing.
    </p>

    <div class="checkbox-row">
      <vscode-checkbox
        checked={removeAll}
        onchange={handleCheckboxChange}
        disabled={isSubmitting}
        label="Remove all workspaces and their branches"
      ></vscode-checkbox>
    </div>

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
  p {
    margin: 0 0 16px 0;
    font-size: 13px;
    color: var(--ch-foreground);
  }

  .checkbox-row {
    margin-bottom: 16px;
  }

  .error-text {
    white-space: pre-line;
  }
</style>
