<script lang="ts">
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";
  import { workspaces, type WorkspaceRef } from "$lib/api";
  import { closeDialog } from "$lib/stores/dialogs.svelte.js";
  import { getAllWorkspaces } from "$lib/stores/projects.svelte.js";
  import { createLogger } from "$lib/logging";

  const logger = createLogger("ui");

  interface RemoveWorkspaceDialogProps {
    open: boolean;
    workspaceRef: WorkspaceRef;
  }

  let { open, workspaceRef }: RemoveWorkspaceDialogProps = $props();

  // Form state
  let keepBranch = $state(false);
  let isDirty = $state(false);
  let unmergedCommits = $state(0);
  let isCheckingStatus = $state(true);

  // Extract workspace name from ref
  const workspaceName = $derived(workspaceRef.workspaceName);

  // Get the base branch name from workspace metadata
  const baseBranch = $derived(() => {
    const ws = getAllWorkspaces().find((w) => w.path === workspaceRef.path);
    return ws?.metadata?.base;
  });

  // Check workspace status on mount
  $effect(() => {
    if (!open) return;

    isCheckingStatus = true;
    isDirty = false;
    unmergedCommits = 0;

    workspaces
      .getStatus(workspaceRef.path)
      .then((status) => {
        isDirty = status.isDirty;
        unmergedCommits = status.unmergedCommits;
      })
      .catch(() => {
        isDirty = false;
        unmergedCommits = 0;
      })
      .finally(() => {
        isCheckingStatus = false;
      });
  });

  // Handle form submission (fire-and-forget)
  function handleSubmit(): void {
    logger.debug("Dialog submitted", { type: "remove-workspace" });
    // Fire-and-forget: start deletion and close dialog immediately
    // Progress is shown via DeletionProgressView in MainView
    void workspaces.remove(workspaceRef.path, { keepBranch });
    closeDialog();
  }

  // Handle cancel
  function handleCancel(): void {
    logger.debug("Dialog closed", { type: "remove-workspace" });
    closeDialog();
  }

  // Handle checkbox change (standard change event from vscode-checkbox)
  function handleCheckboxChange(event: Event): void {
    const target = event.target as HTMLElement & { checked: boolean };
    keepBranch = target.checked;
  }

  // IDs for accessibility
  const titleId = "remove-workspace-title";
  const descriptionId = "remove-workspace-desc";
</script>

<Dialog
  {open}
  onClose={handleCancel}
  busy={false}
  {titleId}
  {descriptionId}
  initialFocusSelector="vscode-button"
>
  {#snippet title()}
    <h2 id={titleId} class="ch-dialog-title">Remove Workspace</h2>
  {/snippet}

  {#snippet content()}
    <p id={descriptionId} class="ch-dialog-text">
      Remove workspace "{workspaceName}"?
    </p>

    {#if isCheckingStatus}
      <div class="ch-status-message" role="status">Checking workspace status...</div>
    {:else}
      {#if isDirty}
        <div class="ch-alert-box" role="alert">
          <span class="ch-alert-box-icon">
            <Icon name="warning" />
          </span>
          This workspace has uncommitted changes that will be lost.
        </div>
      {/if}
      {#if unmergedCommits > 0}
        <div class="ch-alert-box" role="alert">
          <span class="ch-alert-box-icon">
            <Icon name="warning" />
          </span>
          This branch has {unmergedCommits} commit{unmergedCommits === 1 ? "" : "s"} not merged into {baseBranch() ??
            "base"}.
        </div>
      {/if}
    {/if}

    <div class="ch-checkbox-row">
      <vscode-checkbox checked={keepBranch} onchange={handleCheckboxChange} label="Keep branch"
      ></vscode-checkbox>
    </div>
  {/snippet}

  {#snippet actions()}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <vscode-button onclick={handleSubmit}>Remove</vscode-button>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <vscode-button secondary={true} onclick={handleCancel}>Cancel</vscode-button>
  {/snippet}
</Dialog>

<style>
  /* All shared styles now in variables.css */
</style>
