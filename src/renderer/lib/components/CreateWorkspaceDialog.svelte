<script lang="ts">
  import Dialog from "./Dialog.svelte";
  import BranchDropdown from "./BranchDropdown.svelte";
  import ProjectDropdown from "./ProjectDropdown.svelte";
  import NameBranchDropdown, { type NameBranchSelection } from "./NameBranchDropdown.svelte";
  import Icon from "./Icon.svelte";
  import {
    workspaces,
    projects as projectsApi,
    type Workspace,
    type ProjectId,
    type Project,
  } from "$lib/api";
  import { validateWorkspaceName, type InitialPrompt } from "@shared/api/types";
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

  // More options state
  let showMoreOptions = $state(false);
  let initialPrompt = $state("");
  let agentMode = $state<"" | "plan">("");
  let openInBackground = $state(false);
  let agentModeRef: HTMLElement | undefined = $state();

  // Direct event listener for vscode-single-select: its change event doesn't bubble,
  // but Svelte 5 delegates 'change' to the document root, so onchange= misses it.
  $effect(() => {
    const el = agentModeRef;
    if (!el) return;
    const handler = (e: Event) => {
      agentMode = (e.target as HTMLSelectElement).value as "" | "plan";
    };
    el.addEventListener("change", handler);
    return () => el.removeEventListener("change", handler);
  });

  // Get existing workspace names for duplicate validation (uses selectedProjectId)
  const existingNames = $derived.by(() => {
    const project = getProjectById(selectedProjectId);
    return project?.workspaces.map((w: Workspace) => w.name.toLowerCase()) ?? [];
  });

  // Validate name
  function validateName(value: string): string | null {
    const formatError = validateWorkspaceName(value);
    if (formatError) return formatError;
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

  // Toggle more options visibility
  function toggleMoreOptions(): void {
    showMoreOptions = !showMoreOptions;
    // Re-focus the toggle after DOM updates (it moves between actions row and content area)
    setTimeout(() => {
      const toggle = document.querySelector(".more-options-toggle") as HTMLElement | null;
      toggle?.focus();
    }, 0);
  }

  // Handle form submission
  async function handleSubmit(): Promise<void> {
    // isFormValid includes hasProject check, so selectedProject is defined
    if (!isFormValid || isSubmitting || !selectedProject) return;

    submitError = null;
    isSubmitting = true;

    try {
      logger.debug("Dialog submitted", { type: "create-workspace" });

      // Build options from "More options" fields
      const options: { initialPrompt?: InitialPrompt; stealFocus?: boolean } = {};
      const trimmedPrompt = initialPrompt.trim();
      if (trimmedPrompt || agentMode) {
        options.initialPrompt = agentMode
          ? { prompt: trimmedPrompt, agent: agentMode }
          : trimmedPrompt;
      }
      if (openInBackground) {
        options.stealFocus = false;
      }

      await workspaces.create(
        selectedProject.path,
        name,
        selectedBranch,
        Object.keys(options).length > 0 ? options : undefined
      );
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
      const project: Project | null = await projectsApi.open();
      if (!project) {
        // User cancelled folder picker
        return;
      }
      handleProjectSelect(project.id);
      // Focus name input for efficient form completion
      setTimeout(() => nameInputRef?.focus(), 0);
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("Failed to open project from dialog", { error: message });
      submitError = message;
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

{#snippet moreOptionsToggle()}
  <button
    class="more-options-toggle"
    onclick={toggleMoreOptions}
    disabled={isSubmitting}
    type="button"
  >
    <Icon name={showMoreOptions ? "chevron-down" : "chevron-right"} />
    More options
  </button>
{/snippet}

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
      {#if selectedProject}
        <NameBranchDropdown
          id="workspace-name"
          projectPath={selectedProject.path}
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
      {#if selectedProject}
        <BranchDropdown
          projectPath={selectedProject.path}
          value={selectedBranch}
          onSelect={handleBranchSelect}
          disabled={isSubmitting || isOpeningProject}
        />
      {:else}
        <vscode-textfield id="branch-select" disabled></vscode-textfield>
      {/if}
    </div>

    {#if showMoreOptions}
      {@render moreOptionsToggle()}

      <div class="more-options-box">
        <div class="ch-form-field">
          <label for="initial-prompt" class="ch-form-label">Initial prompt</label>
          <vscode-textarea
            id="initial-prompt"
            value={initialPrompt}
            oninput={(e: Event) => {
              initialPrompt = (e.target as HTMLTextAreaElement).value;
            }}
            disabled={isSubmitting}
            rows={3}
            resize="vertical"
            placeholder="Optional prompt to send after creation"
          ></vscode-textarea>
        </div>

        <div class="ch-form-field">
          <label for="agent-mode" class="ch-form-label">Agent</label>
          <vscode-single-select
            id="agent-mode"
            bind:this={agentModeRef}
            value={agentMode}
            disabled={isSubmitting}
          >
            <vscode-option value="">Full permissions</vscode-option>
            <vscode-option value="plan">Plan mode (read-only)</vscode-option>
          </vscode-single-select>
        </div>

        <div class="ch-checkbox-row">
          <vscode-checkbox
            checked={openInBackground}
            onchange={(e: Event) => {
              openInBackground = (e.target as HTMLElement & { checked: boolean }).checked;
            }}
            disabled={isSubmitting}
            label="Open in background"
          ></vscode-checkbox>
        </div>
      </div>
    {/if}

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
    {#if !showMoreOptions}
      {@render moreOptionsToggle()}
    {/if}
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

  .more-options-box {
    border: 1px solid var(--ch-input-border);
    border-radius: 4px;
    padding: 12px;
    margin-bottom: 0;
  }

  .more-options-toggle {
    all: unset;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
    color: var(--ch-foreground);
    opacity: 0.8;
    cursor: pointer;
    margin-right: auto;
  }

  .more-options-toggle:hover {
    opacity: 1;
  }

  .more-options-toggle:focus-visible {
    opacity: 1;
    outline: 1px solid var(--ch-focus-border);
    outline-offset: 2px;
  }

  .more-options-toggle:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
