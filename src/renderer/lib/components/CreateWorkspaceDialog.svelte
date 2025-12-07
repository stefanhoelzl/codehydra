<script lang="ts">
  import Dialog from "./Dialog.svelte";
  import BranchDropdown from "./BranchDropdown.svelte";
  import { createWorkspace, type Workspace } from "$lib/api";
  import { closeDialog } from "$lib/stores/dialogs.svelte.js";
  import { projects } from "$lib/stores/projects.svelte.js";

  interface CreateWorkspaceDialogProps {
    open: boolean;
    projectPath: string;
  }

  let { open, projectPath }: CreateWorkspaceDialogProps = $props();

  // Form state
  let name = $state("");
  let selectedBranch = $state("");
  let nameError = $state<string | null>(null);
  let submitError = $state<string | null>(null);
  let isSubmitting = $state(false);
  let touched = $state(false);

  // Get existing workspace names for duplicate validation
  const existingNames = $derived.by(() => {
    const project = projects.value.find((p) => p.path === projectPath);
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

  // Handle branch selection
  function handleBranchSelect(branch: string): void {
    selectedBranch = branch;
  }

  // Handle form submission
  async function handleSubmit(): Promise<void> {
    if (!isFormValid || isSubmitting) return;

    submitError = null;
    isSubmitting = true;

    try {
      await createWorkspace(projectPath, name, selectedBranch);
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
      <label for="workspace-name">Name</label>
      <input
        id="workspace-name"
        type="text"
        value={name}
        oninput={handleNameInput}
        onblur={handleNameBlur}
        disabled={isSubmitting}
        aria-describedby={nameErrorId}
        aria-invalid={nameError ? "true" : undefined}
      />
      <span id={nameErrorId} class="error-message" role="alert" aria-live="polite">
        {nameError ?? ""}
      </span>
    </div>

    <div class="form-field">
      <label for="branch-select">Base Branch</label>
      <BranchDropdown
        {projectPath}
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
    <button type="button" class="cancel-button" onclick={handleCancel} disabled={isSubmitting}>
      Cancel
    </button>
    <button
      type="button"
      class="ok-button"
      onclick={handleSubmit}
      disabled={!isFormValid || isSubmitting}
    >
      {isSubmitting ? "Creating..." : "Create"}
    </button>
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

  input[type="text"] {
    width: 100%;
    padding: 6px 8px;
    background: var(--ch-input-bg);
    color: var(--ch-foreground);
    border: 1px solid var(--ch-input-border);
    border-radius: 2px;
    font-size: 13px;
    box-sizing: border-box;
  }

  input[type="text"]:focus {
    outline: none;
    border-color: var(--ch-focus-border);
  }

  input[type="text"]:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  input[aria-invalid="true"] {
    border-color: var(--ch-error-fg);
  }

  .error-message {
    display: block;
    margin-top: 4px;
    font-size: 12px;
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

  button {
    padding: 6px 14px;
    font-size: 13px;
    border-radius: 2px;
    cursor: pointer;
    border: none;
  }

  .cancel-button {
    background: transparent;
    color: var(--ch-foreground);
    border: 1px solid var(--ch-input-border);
  }

  .cancel-button:hover:not(:disabled) {
    background: var(--ch-input-bg);
  }

  .ok-button {
    background: var(--ch-button-bg);
    color: var(--ch-button-fg);
  }

  .ok-button:hover:not(:disabled) {
    opacity: 0.9;
  }

  .ok-button:disabled,
  .cancel-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
