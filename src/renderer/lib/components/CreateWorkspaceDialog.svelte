<script lang="ts">
  import Dialog from "./Dialog.svelte";
  import BranchDropdown from "./BranchDropdown.svelte";
  import ProjectDropdown from "./ProjectDropdown.svelte";
  import NameBranchDropdown, { type NameBranchSelection } from "./NameBranchDropdown.svelte";
  import Icon from "./Icon.svelte";
  import {
    workspaces,
    ui,
    projects as projectsApi,
    type Workspace,
    type ProjectId,
  } from "$lib/api";
  import { closeDialog, openGitCloneDialog } from "$lib/stores/dialogs.svelte.js";
  import { getProjectById, projects } from "$lib/stores/projects.svelte.js";
  import { createLogger } from "$lib/logging";
  import { getErrorMessage } from "@shared/error-utils";

  const logger = createLogger("ui");

  interface CreateWorkspaceDialogProps {
    open: boolean;
    projectId?: ProjectId | undefined;
    /** Called when user cancels the dialog (before closeDialog is called) */
    onCancel?: () => void;
  }

  let { open, projectId, onCancel }: CreateWorkspaceDialogProps = $props();

  // Form state
  // Track user's project selection, null means use the prop value
  let userSelectedProject = $state<ProjectId | null>(null);
  // Effective selected project: user selection, prop, or first available project
  const selectedProjectId = $derived(userSelectedProject ?? projectId ?? projects.value[0]?.id);

  // Whether we have a valid project to create workspace in
  const hasProject = $derived(selectedProjectId !== undefined);

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
  let isOpeningProject = $state(false);
  let touched = $state(false);
  let createButtonRef: HTMLElement | undefined = $state();
  let nameInputRef: { focus: () => void } | undefined = $state();

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
    hasProject && name.trim() !== "" && selectedBranch !== "" && validateName(name) === null
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
    // isFormValid includes hasProject check, so selectedProjectId is defined
    if (!isFormValid || isSubmitting || !selectedProjectId) return;

    submitError = null;
    isSubmitting = true;

    try {
      logger.debug("Dialog submitted", { type: "create-workspace" });
      const workspace = await workspaces.create(selectedProjectId, name, selectedBranch);
      // Switch to the newly created workspace to load its view
      await ui.switchWorkspace(workspace.path);
      closeDialog();
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("UI error", { component: "CreateWorkspaceDialog", error: message });
      submitError = message;
      isSubmitting = false;
    }
  }

  // Handle opening git clone dialog
  function handleCloneProject(): void {
    if (isSubmitting || isOpeningProject) return;
    logger.debug("Opening git clone dialog");
    openGitCloneDialog();
  }

  // Handle opening a project via folder picker
  async function handleOpenProject(): Promise<void> {
    if (isSubmitting || isOpeningProject) return;

    isOpeningProject = true;
    submitError = null;

    try {
      const path = await ui.selectFolder();
      if (!path) {
        // User cancelled folder picker
        return;
      }

      try {
        await projectsApi.open(path);
        // Find the newly opened project (it will be the one with the matching path)
        const newProject = projects.value.find((p) => p.path === path);
        if (newProject) {
          handleProjectSelect(newProject.id);
          // Focus name input for efficient form completion
          setTimeout(() => nameInputRef?.focus(), 0);
        }
      } catch (error) {
        const message = getErrorMessage(error);
        logger.warn("Failed to open project from dialog", { path, error: message });
        submitError = message;
      }
    } finally {
      isOpeningProject = false;
    }
  }

  // Handle cancel
  function handleCancel(): void {
    logger.debug("Dialog closed", { type: "create-workspace" });
    onCancel?.();
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
      <div class="project-row">
        <!-- Icon buttons first in tab order, but visually on the right via CSS order -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <vscode-button
          class="folder-button"
          appearance="icon"
          aria-label="Open project folder"
          title="Open project folder"
          onclick={handleOpenProject}
          disabled={isSubmitting || isOpeningProject}
        >
          <Icon name="folder-opened" />
        </vscode-button>
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <vscode-button
          class="clone-button"
          appearance="icon"
          aria-label="Clone from Git"
          title="Clone from Git"
          onclick={handleCloneProject}
          disabled={isSubmitting || isOpeningProject}
        >
          <Icon name="source-control" />
        </vscode-button>
        {#if selectedProjectId}
          <ProjectDropdown
            value={selectedProjectId}
            onSelect={handleProjectSelect}
            disabled={isSubmitting || isOpeningProject}
          />
        {:else}
          <vscode-textfield
            placeholder="Open folder or clone from Git"
            disabled
            class="no-project-placeholder"
          ></vscode-textfield>
        {/if}
      </div>
    </div>

    <div class="ch-form-field">
      <label for="workspace-name" class="ch-form-label">Name</label>
      {#if selectedProjectId}
        <NameBranchDropdown
          id="workspace-name"
          projectId={selectedProjectId}
          value={name}
          onSelect={handleNameSelect}
          onInput={handleNameInput}
          disabled={isSubmitting || isOpeningProject}
          onEnter={handleEnterInName}
          autofocus={true}
          bind:this={nameInputRef}
        />
      {:else}
        <vscode-textfield id="workspace-name" disabled></vscode-textfield>
      {/if}
      {#if nameError}
        <vscode-form-helper id={nameErrorId}>
          <span class="error-text">{nameError}</span>
        </vscode-form-helper>
      {/if}
    </div>

    <div class="ch-form-field">
      <label for="branch-select" class="ch-form-label">Base Branch</label>
      {#if selectedProjectId}
        <BranchDropdown
          projectId={selectedProjectId}
          value={selectedBranch}
          onSelect={handleBranchSelect}
          disabled={isSubmitting || isOpeningProject}
        />
      {:else}
        <vscode-textfield id="branch-select" disabled></vscode-textfield>
      {/if}
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
      disabled={!isFormValid || isSubmitting || isOpeningProject}
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

  .project-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
  }

  /* Icon buttons are first in DOM (for tab order) but visually last */
  .project-row :global(.folder-button) {
    order: 1;
  }

  .project-row :global(.clone-button) {
    order: 2;
  }

  /* ProjectDropdown stretches to fill available space */
  .project-row :global(.project-dropdown) {
    flex: 1;
  }

  /* Placeholder textfield when no project selected */
  .project-row :global(.no-project-placeholder) {
    flex: 1;
  }
</style>
