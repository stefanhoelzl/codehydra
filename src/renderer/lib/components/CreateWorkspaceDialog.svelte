<script lang="ts">
  import Dialog from "./Dialog.svelte";
  import BranchDropdown from "./BranchDropdown.svelte";
  import ProjectDropdown from "./ProjectDropdown.svelte";
  import NameBranchDropdown, { type NameBranchSelection } from "./NameBranchDropdown.svelte";
  import { workspaces, ui, type Workspace, type ProjectId } from "$lib/api";
  import { closeDialog } from "$lib/stores/dialogs.svelte.js";
  import { getProjectById } from "$lib/stores/projects.svelte.js";
  import { createLogger } from "$lib/logging";
  import { getErrorMessage } from "@shared/error-utils";

  const logger = createLogger("ui");

  interface CreateWorkspaceDialogProps {
    open: boolean;
    projectId: ProjectId;
  }

  let { open, projectId }: CreateWorkspaceDialogProps = $props();

  // Form state
  // Track user's project selection, null means use the prop value
  let userSelectedProject = $state<ProjectId | null>(null);
  // Effective selected project: user selection or fall back to prop
  const selectedProjectId = $derived(userSelectedProject ?? projectId);

  // Get the selected project and its default base branch reactively
  const selectedProject = $derived(getProjectById(selectedProjectId));
  const defaultBranch = $derived(selectedProject?.defaultBaseBranch);

  let name = $state("");
  let selectedBranch = $state("");

  // Initialize selectedBranch from project's default when available.
  // Only sets the branch if user hasn't selected anything yet (selectedBranch === "").
  // This handles the case where defaultBaseBranch becomes available after mount,
  // and when user switches projects (selectedBranch is cleared to "").
  $effect(() => {
    if (selectedBranch === "" && defaultBranch) {
      selectedBranch = defaultBranch;
    }
  });
  let nameError = $state<string | null>(null);
  let submitError = $state<string | null>(null);
  let isSubmitting = $state(false);
  let touched = $state(false);
  let createButtonRef: HTMLElement | undefined = $state();

  // Get existing workspace names for duplicate validation (uses selectedProjectId)
  const existingNames = $derived.by(() => {
    const project = getProjectById(selectedProjectId);
    return project?.workspaces.map((w: Workspace) => w.name.toLowerCase()) ?? [];
  });

  // Validate name
  function validateName(value: string): string | null {
    if (!value.trim()) return "Name is required";
    if (value.includes("/")) return "Name cannot contain /";
    if (value.includes("\\")) return "Name cannot contain \\";
    if (value.includes("..")) return "Name cannot contain ..";
    if (value.length > 100) return "Name must be 100 characters or less";
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
      return "Name can only contain letters, numbers, dash, underscore";
    }
    if (existingNames.includes(value.toLowerCase())) return "Workspace already exists";
    return null;
  }

  // Check if form is valid
  const isFormValid = $derived(
    name.trim() !== "" && selectedBranch !== "" && validateName(name) === null
  );

  // Handle project selection - clears branch and re-validates name
  function handleProjectSelect(newProjectId: ProjectId): void {
    logger.debug("Project selected", { projectId: newProjectId });
    userSelectedProject = newProjectId;
    // Clear branch selection since we're switching projects
    selectedBranch = "";
    // Re-validate name when project changes if user has already interacted
    if (touched) {
      nameError = validateName(name);
    }
  }

  // Handle name input changes (tracks typed text for form validation)
  function handleNameInput(value: string): void {
    name = value;
    // Don't show validation errors while typing - only update form validity
    // Errors will be shown on selection (Enter key or dropdown click)
  }

  // Handle name selection from NameBranchDropdown.
  // Validation happens on selection (Enter key or dropdown click), not on blur.
  // This is intentional: the NameBranchDropdown triggers onSelect when the user
  // commits a value via Enter or selection, providing immediate feedback.
  function handleNameSelect(selection: NameBranchSelection): void {
    name = selection.name;

    // Auto-fill base branch when selecting an existing branch
    if (selection.isExistingBranch && selection.suggestedBase) {
      selectedBranch = selection.suggestedBase;
    }

    // Validate on selection
    touched = true;
    nameError = validateName(name);
  }

  // Handle Enter key in name input - submit if form is valid
  function handleEnterInName(): void {
    if (isFormValid) {
      handleSubmit();
    }
  }

  // Handle branch selection
  function handleBranchSelect(branch: string): void {
    selectedBranch = branch;
    // Focus the Create button after branch selection
    setTimeout(() => createButtonRef?.focus(), 0);
  }

  // Handle form submission
  async function handleSubmit(): Promise<void> {
    if (!isFormValid || isSubmitting) return;

    submitError = null;
    isSubmitting = true;

    try {
      logger.debug("Dialog submitted", { type: "create-workspace" });
      const workspace = await workspaces.create(selectedProjectId, name, selectedBranch);
      // Switch to the newly created workspace to load its view
      await ui.switchWorkspace(selectedProjectId, workspace.name);
      closeDialog();
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("UI error", { component: "CreateWorkspaceDialog", error: message });
      submitError = message;
      isSubmitting = false;
    }
  }

  // Handle cancel
  function handleCancel(): void {
    logger.debug("Dialog closed", { type: "create-workspace" });
    closeDialog();
  }

  // IDs for accessibility
  const titleId = "create-workspace-title";
  const descriptionId = "create-workspace-desc";
  const nameErrorId = "name-error";
</script>

<Dialog {open} onClose={handleCancel} busy={isSubmitting} {titleId} {descriptionId}>
  {#snippet title()}
    <h2 id={titleId} class="ch-dialog-title">Create Workspace</h2>
  {/snippet}

  {#snippet content()}
    <div class="ch-form-field">
      <label for="project-select" class="ch-form-label">Project</label>
      <ProjectDropdown
        value={selectedProjectId}
        onSelect={handleProjectSelect}
        disabled={isSubmitting}
      />
    </div>

    <div class="ch-form-field">
      <label for="workspace-name" class="ch-form-label">Name</label>
      <NameBranchDropdown
        id="workspace-name"
        projectId={selectedProjectId}
        value={name}
        onSelect={handleNameSelect}
        onInput={handleNameInput}
        disabled={isSubmitting}
        onEnter={handleEnterInName}
        autofocus={true}
      />
      {#if nameError}
        <vscode-form-helper id={nameErrorId}>
          <span class="error-text">{nameError}</span>
        </vscode-form-helper>
      {/if}
    </div>

    <div class="ch-form-field">
      <label for="branch-select" class="ch-form-label">Base Branch</label>
      <BranchDropdown
        projectId={selectedProjectId}
        value={selectedBranch}
        onSelect={handleBranchSelect}
        disabled={isSubmitting}
      />
    </div>

    {#if isSubmitting}
      <div class="ch-status-message" aria-live="polite">Creating workspace...</div>
    {/if}

    {#if submitError}
      <div class="ch-alert-box" role="alert">
        {submitError}
      </div>
    {/if}
  {/snippet}

  {#snippet actions()}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <vscode-button
      bind:this={createButtonRef}
      onclick={handleSubmit}
      disabled={!isFormValid || isSubmitting}
    >
      {isSubmitting ? "Creating..." : "Create"}
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
    color: var(--ch-error-fg);
  }
</style>
