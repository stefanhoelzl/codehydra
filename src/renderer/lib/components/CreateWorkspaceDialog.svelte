<script lang="ts">
  import Dialog from "./Dialog.svelte";
  import BranchDropdown from "./BranchDropdown.svelte";
  import ProjectDropdown from "./ProjectDropdown.svelte";
  import { createWorkspace, type Workspace } from "$lib/api";
  import { closeDialog } from "$lib/stores/dialogs.svelte.js";
  import { projects } from "$lib/stores/projects.svelte.js";

  interface CreateWorkspaceDialogProps {
    open: boolean;
    projectPath: string;
  }

  let { open, projectPath }: CreateWorkspaceDialogProps = $props();

  // Get project default base branch
  const project = $derived(projects.value.find((p) => p.path === projectPath));

  // Form state
  // Track user's project selection, null means use the prop value
  let userSelectedProject = $state<string | null>(null);
  // Effective selected project: user selection or fall back to prop
  const selectedProject = $derived(userSelectedProject ?? projectPath);

  let name = $state("");
  // Initialize selectedBranch from project's default base branch.
  // This is initialization-only: the value is captured once when the component mounts.
  // If the project changes, the dialog should be remounted (closed and reopened) to
  // pick up the new project's default branch.
  // svelte-ignore state_referenced_locally
  let selectedBranch = $state(project?.defaultBaseBranch ?? "");
  let nameError = $state<string | null>(null);
  let submitError = $state<string | null>(null);
  let isSubmitting = $state(false);
  let touched = $state(false);
  let createButtonRef: HTMLElement | undefined = $state();
  let nameInputRef: HTMLElement | undefined = $state();

  // Focus name input when dialog opens (with delay to ensure DOM is ready)
  $effect(() => {
    if (open && nameInputRef) {
      // Use setTimeout to ensure focus happens after all initializations
      setTimeout(() => nameInputRef?.focus(), 0);
    }
  });

  // Get existing workspace names for duplicate validation (uses selectedProject)
  const existingNames = $derived.by(() => {
    const project = projects.value.find((p) => p.path === selectedProject);
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
  function handleProjectSelect(path: string): void {
    userSelectedProject = path;
    // Clear branch selection since we're switching projects
    selectedBranch = "";
    // Re-validate name when project changes if user has already interacted
    if (touched) {
      nameError = validateName(name);
    }
  }

  // Handle name input
  function handleNameInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    name = target.value;
    if (touched) {
      nameError = validateName(name);
    }
  }

  // Handle name blur (validate on blur)
  function handleNameBlur(): void {
    touched = true;
    nameError = validateName(name);
  }

  // Handle Enter key on name input to submit form
  function handleNameKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && isFormValid && !isSubmitting) {
      event.preventDefault();
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
      await createWorkspace(selectedProject, name, selectedBranch);
      closeDialog();
    } catch (error) {
      submitError = error instanceof Error ? error.message : "Failed to create workspace";
      isSubmitting = false;
    }
  }

  // Handle cancel
  function handleCancel(): void {
    closeDialog();
  }

  // IDs for accessibility
  const titleId = "create-workspace-title";
  const descriptionId = "create-workspace-desc";
  const nameErrorId = "name-error";
</script>

<Dialog {open} onClose={handleCancel} busy={isSubmitting} {titleId} {descriptionId}>
  {#snippet title()}
    <h2 id={titleId}>Create Workspace</h2>
  {/snippet}

  {#snippet content()}
    <div class="form-field">
      <label for="project-select">Project</label>
      <ProjectDropdown
        value={selectedProject}
        onSelect={handleProjectSelect}
        disabled={isSubmitting}
      />
    </div>

    <div class="form-field">
      <label for="workspace-name">Name</label>
      <vscode-textfield
        bind:this={nameInputRef}
        id="workspace-name"
        role="textbox"
        tabindex="0"
        value={name}
        oninput={handleNameInput}
        onblur={handleNameBlur}
        onkeydown={handleNameKeydown}
        disabled={isSubmitting}
        aria-describedby={nameErrorId}
        invalid={nameError ? true : undefined}
      ></vscode-textfield>
      {#if nameError}
        <vscode-form-helper id={nameErrorId}>
          <span class="error-text">{nameError}</span>
        </vscode-form-helper>
      {/if}
    </div>

    <div class="form-field">
      <label for="branch-select">Base Branch</label>
      <BranchDropdown
        projectPath={selectedProject}
        value={selectedBranch}
        onSelect={handleBranchSelect}
        disabled={isSubmitting}
      />
    </div>

    {#if isSubmitting}
      <div class="status-message" aria-live="polite">Creating workspace...</div>
    {/if}

    {#if submitError}
      <div class="submit-error" role="alert">
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
  h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--ch-foreground);
  }

  .form-field {
    margin-bottom: 16px;
  }

  label {
    display: block;
    margin-bottom: 4px;
    font-size: 13px;
    color: var(--ch-foreground);
  }

  vscode-textfield {
    width: 100%;
    --vscode-font-size: 13px;
  }

  .error-text {
    color: var(--ch-error-fg);
  }

  .status-message {
    margin-bottom: 16px;
    font-size: 13px;
    color: var(--ch-foreground);
    opacity: 0.8;
  }

  .submit-error {
    margin-bottom: 16px;
    padding: 8px;
    background: var(--ch-error-bg);
    color: var(--ch-error-fg);
    border-radius: 2px;
    font-size: 13px;
  }
</style>
