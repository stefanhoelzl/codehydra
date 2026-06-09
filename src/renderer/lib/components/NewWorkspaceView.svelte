<!--
  NewWorkspaceView.svelte

  Full-content-area panel for creating workspaces. Replaces the old modal
  CreateWorkspaceDialog. Differences from the dialog:
  - Rendered as a persistent panel (centered card on an opaque backdrop), not a modal.
  - Advanced settings are always expanded (no collapse toggle).
  - Create runs in the background and does NOT switch to the new workspace.
    The form resets afterwards so the user can fire off another immediately.
  - Escape clears the form (it does not navigate away — leave via Alt+X+↑/↓ or
    by clicking a workspace).
  - Enter never submits except on the Create button; Cmd/Ctrl+Enter submits anywhere.

  Form state (name, branch, prompt, agent) is component-local and preserved while
  the panel stays mounted. The selected project lives in the new-workspace-view
  store so git-clone / folder-open can populate it.
-->
<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
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
  import type { LifecycleAgentType } from "@shared/ipc";
  import { bootstrap } from "$lib/stores/bootstrap.svelte.js";
  import { openGitCloneDialog } from "$lib/stores/dialogs.svelte.js";
  import {
    newWorkspaceView,
    setNewWorkspaceProject,
    resetNewWorkspaceProject,
    closeNewWorkspaceView,
    registerSubmitHandler,
  } from "$lib/stores/new-workspace-view.svelte.js";
  import {
    getProjectById,
    addWorkspace,
    removeWorkspace,
    setActiveWorkspace,
    activeWorkspacePath,
  } from "$lib/stores/projects.svelte.js";
  import {
    createPendingPath,
    addPending,
    removePending,
  } from "$lib/stores/pending-workspaces.svelte.js";
  import { createLogger } from "$lib/logging";
  import { getErrorMessage } from "@shared/error-utils";

  const logger = createLogger("ui");

  interface NewWorkspaceViewProps {
    /** Whether the panel is shown. */
    open: boolean;
  }

  let { open }: NewWorkspaceViewProps = $props();

  // ============ Form state ============

  // Selected project comes from the store (survives across opens; settable by
  // git-clone / folder-open). No pre-fill from the active workspace's project.
  const selectedProjectId = $derived(newWorkspaceView.selectedProjectId);
  const hasProject = $derived(selectedProjectId !== undefined);
  const selectedProject = $derived(getProjectById(selectedProjectId));
  const defaultBranch = $derived(selectedProject?.defaultBaseBranch);

  let name = $state("");
  let selectedBranch = $state("");
  let nameError = $state<string | null>(null);
  let submitError = $state<string | null>(null);
  let isSubmitting = $state(false);
  let isOpeningProject = $state(false);
  let touched = $state(false);

  let initialPrompt = $state("");
  let agentMode = $state<"" | "plan">("");
  let agentModeRef: HTMLElement | undefined = $state();
  // Per-workspace agent override. "" means "use the global default".
  let selectedAgent = $state<LifecycleAgentType | "">("");
  let agentSelectRef: HTMLElement | undefined = $state();

  let nameInputRef: { focus: () => void } | undefined = $state();
  let promptRef: HTMLElement | undefined = $state();
  // Section ref for focus-trap enumeration.
  let sectionRef: HTMLElement | undefined = $state();

  // Auto-fill the base branch from the project's default. Each distinct default
  // value is applied at most once per project selection, and only into an empty
  // field: re-applying after BranchDropdown cleared a stale default would
  // ping-pong forever (effect_update_depth_exceeded bricked the whole renderer
  // once), while a *fresh* default arriving later is a new value and still fills
  // the empty field. Defined before the apply effect so the reset runs first on
  // project switches.
  const appliedDefaults = new SvelteSet<string>();
  $effect(() => {
    void selectedProjectId;
    appliedDefaults.clear();
  });

  $effect(() => {
    const branch = defaultBranch;
    if (selectedBranch === "" && branch && !appliedDefaults.has(branch)) {
      appliedDefaults.add(branch);
      selectedBranch = branch;
    }
  });

  // Default agent dropdown when bootstrap data arrives.
  $effect(() => {
    if (selectedAgent === "" && bootstrap.defaultAgent) {
      selectedAgent = bootstrap.defaultAgent;
    }
  });

  // vscode-single-select's change event doesn't bubble — bind directly.
  $effect(() => {
    const el = agentSelectRef;
    if (!el) return;
    const handler = (e: Event): void => {
      selectedAgent = (e.target as HTMLSelectElement).value as LifecycleAgentType | "";
    };
    el.addEventListener("change", handler);
    return () => el.removeEventListener("change", handler);
  });

  $effect(() => {
    const el = agentModeRef;
    if (!el) return;
    const handler = (e: Event): void => {
      agentMode = (e.target as HTMLSelectElement).value as "" | "plan";
    };
    el.addEventListener("change", handler);
    return () => el.removeEventListener("change", handler);
  });

  // Existing workspace names for duplicate validation.
  const existingNames = $derived.by(() => {
    const project = getProjectById(selectedProjectId);
    return project?.workspaces.map((w: Workspace) => w.name.toLowerCase()) ?? [];
  });

  function validateName(value: string): string | null {
    const formatError = validateWorkspaceName(value);
    if (formatError) return formatError;
    if (existingNames.includes(value.toLowerCase())) return "Workspace already exists";
    return null;
  }

  const isFormValid = $derived(
    hasProject && name.trim() !== "" && selectedBranch !== "" && validateName(name) === null
  );

  // ============ Field handlers ============

  function handleProjectSelect(newProjectId: ProjectId): void {
    logger.debug("Project selected", { projectId: newProjectId });
    setNewWorkspaceProject(newProjectId);
    // Clear branch selection since we're switching projects.
    selectedBranch = "";
    if (touched) {
      nameError = validateName(name);
    }
  }

  function handleNameInput(value: string): void {
    name = value;
  }

  function handleNameSelect(selection: NameBranchSelection): void {
    name = selection.name;
    if (selection.isExistingBranch && selection.suggestedBase) {
      selectedBranch = selection.suggestedBase;
    }
    touched = true;
    nameError = validateName(name);
  }

  // Enter in the name field advances to the prompt (prompt-first) — it never submits.
  function handleEnterInName(): void {
    promptRef?.focus();
  }

  function handleBranchSelect(branch: string): void {
    selectedBranch = branch;
  }

  // ============ Submit ============

  // Create the workspace in the background. Does NOT switch to it: the queued
  // prompt fires once the agent is ready, while the user stays on this view
  // (or navigates elsewhere). Resets the form afterwards for the next create.
  function handleSubmit(): void {
    if (!isFormValid || isSubmitting || !selectedProject) return;
    isSubmitting = true;

    logger.debug("New workspace submitted");

    const options: {
      initialPrompt?: InitialPrompt;
      stealFocus?: boolean;
      agent?: LifecycleAgentType;
    } = {};
    const trimmedPrompt = initialPrompt.trim();
    if (trimmedPrompt || agentMode) {
      options.initialPrompt = agentMode
        ? { prompt: trimmedPrompt, agent: agentMode }
        : trimmedPrompt;
    }
    if (selectedAgent !== "" && selectedAgent !== bootstrap.defaultAgent) {
      options.agent = selectedAgent;
    }

    const project = selectedProject;
    const workspaceName = name;
    const branch = selectedBranch;

    // Optimistic placeholder so the workspace appears in the sidebar immediately
    // (rendered with the red "busy" indicator while creating).
    const pendingPath = createPendingPath(project.path, workspaceName);
    const placeholder: Workspace = {
      projectId: project.id,
      name: workspaceName as Workspace["name"],
      branch,
      metadata: {},
      path: pendingPath,
    };
    addWorkspace(project.path, placeholder);
    addPending(pendingPath, project.path, workspaceName);

    // Always switch to the new workspace and leave the view — even when a
    // prompt is queued. Backgrounding the create made it unclear that the
    // workspace had actually been made; landing in the (loading) workspace is
    // the visual confirmation.
    setActiveWorkspace(pendingPath);
    closeNewWorkspaceView();
    resetForm();

    // Fire-and-forget; clean up the placeholder on error.
    workspaces
      .create(
        project.path,
        workspaceName,
        branch,
        Object.keys(options).length > 0 ? options : undefined
      )
      .catch((error: unknown) => {
        const message = getErrorMessage(error);
        logger.warn("Workspace creation failed", { name: workspaceName, error: message });
        removePending(pendingPath);
        removeWorkspace(project.path, pendingPath);
        if (activeWorkspacePath.value === pendingPath) {
          setActiveWorkspace(null);
        }
      });
  }

  // Reset the whole form to defaults (used after create and on Escape).
  function resetForm(): void {
    // Re-arm the default auto-fill: a reset is a deliberate user action (submit
    // or Escape), so re-applying the same default afterwards cannot loop.
    appliedDefaults.clear();
    name = "";
    selectedBranch = "";
    initialPrompt = "";
    agentMode = "";
    selectedAgent = bootstrap.defaultAgent ?? "";
    nameError = null;
    submitError = null;
    touched = false;
    isSubmitting = false;
    resetNewWorkspaceProject();
  }

  // ============ Project row (git clone / folder open) ============

  function handleCloneProject(): void {
    if (isSubmitting || isOpeningProject) return;
    logger.debug("Opening git clone dialog");
    openGitCloneDialog();
  }

  async function handleOpenProject(): Promise<void> {
    if (isSubmitting || isOpeningProject) return;
    isOpeningProject = true;
    submitError = null;
    try {
      const project: Project | null = await projectsApi.open();
      if (!project) return; // User cancelled folder picker
      handleProjectSelect(project.id);
      setTimeout(() => nameInputRef?.focus(), 0);
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("Failed to open project from view", { error: message });
      submitError = message;
    } finally {
      isOpeningProject = false;
    }
  }

  // ============ Keyboard ============

  // Cmd/Ctrl+Enter submits; Escape clears the form; Tab/Shift+Tab is trapped
  // at the panel boundaries so focus doesn't leak into the sidebar.
  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      handleSubmit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      resetForm();
      return;
    }
    if (event.key === "Tab") {
      const section = sectionRef;
      if (!section) return;
      // Enumerate every focusable inside the panel — including the
      // vscode-elements custom components — so Tab cycles within the view
      // regardless of which element is currently focused.
      const focusables = Array.from(
        section.querySelectorAll<HTMLElement>(
          [
            "input:not([disabled])",
            "textarea:not([disabled])",
            "button:not([disabled])",
            "select:not([disabled])",
            "vscode-button:not([disabled])",
            "vscode-textfield:not([disabled])",
            "vscode-textarea:not([disabled])",
            "vscode-single-select:not([disabled])",
            '[tabindex]:not([tabindex="-1"])',
          ].join(",")
        )
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      const inSection = active instanceof Node && section.contains(active);
      if (event.shiftKey) {
        if (!inSection || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (!inSection || active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
  }

  // Expose Create to keyboard shortcuts (Alt+X+Enter) while the view is open.
  $effect(() => {
    if (!open) return;
    registerSubmitHandler(handleSubmit);
    return () => registerSubmitHandler(null);
  });

  // Focus the Name field each time the view opens. FilterableDropdown's
  // `autofocus` prop only sets a `data-autofocus` marker (consumed by the
  // Dialog focus trap), which this standalone panel doesn't use — so the
  // focus has to be triggered programmatically.
  let prevOpen = false;
  $effect(() => {
    const nowOpen = open;
    if (nowOpen && !prevOpen) {
      // setTimeout 0 gives the conditionally-rendered NameBranchDropdown a
      // tick to mount and bind nameInputRef.
      setTimeout(() => nameInputRef?.focus(), 0);
    }
    prevOpen = nowOpen;
  });

  const titleId = "new-workspace-title";
  const nameErrorId = "new-workspace-name-error";
</script>

{#if open}
  <!-- Panel-level keydown handles Escape, Cmd/Ctrl+Enter and Tab focus trap. -->
  <section
    bind:this={sectionRef}
    class="new-workspace-view"
    aria-labelledby={titleId}
    onkeydowncapture={handleKeydown}
  >
    <div class="new-workspace-card">
      <h2 id={titleId} class="ch-dialog-title">New workspace</h2>

      <div class="ch-form-field">
        <label for="project-select" class="ch-form-label">Project</label>
        <div class="project-row">
          <!-- Icon buttons first in tab order, visually on the right via CSS order -->
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

      <div class="ch-form-field">
        <label for="initial-prompt" class="ch-form-label">Prompt</label>
        <vscode-textarea
          id="initial-prompt"
          bind:this={promptRef}
          value={initialPrompt}
          oninput={(e: Event) => {
            initialPrompt = (e.target as HTMLTextAreaElement).value;
          }}
          disabled={isSubmitting}
          rows={3}
          resize="vertical"
          placeholder="Optional prompt — sent as soon as the workspace is ready"
        ></vscode-textarea>
      </div>

      {#if bootstrap.availableAgents.length > 1}
        <div class="ch-form-field">
          <label for="agent-select" class="ch-form-label">Agent</label>
          <vscode-single-select
            id="agent-select"
            bind:this={agentSelectRef}
            value={selectedAgent}
            disabled={isSubmitting}
          >
            {#each bootstrap.availableAgents as info (info.agent)}
              <vscode-option value={info.agent}>{info.label}</vscode-option>
            {/each}
          </vscode-single-select>
        </div>
      {/if}

      <div class="ch-form-field">
        <label for="agent-mode" class="ch-form-label">Agent mode</label>
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

      {#if submitError}
        <div class="ch-alert-box" role="alert">
          {submitError}
        </div>
      {/if}

      <div class="new-workspace-actions">
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <vscode-button onclick={handleSubmit} disabled={!isFormValid || isOpeningProject}>
          Create
        </vscode-button>
      </div>
    </div>
  </section>
{/if}

<style>
  .new-workspace-view {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: var(--ch-sidebar-minimized-width, 20px);
    background: var(--ch-surface-0, var(--ch-background));
    display: flex;
    align-items: center;
    justify-content: center;
    overflow-y: auto;
    z-index: 1;
  }

  .new-workspace-card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: min(480px, 90%);
    padding: 24px;
    background: var(--ch-surface-1, var(--ch-background));
    border: 1px solid var(--ch-input-border);
    border-radius: var(--ch-radius-md, 8px);
    box-shadow: var(--ch-shadow);
  }

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

  .project-row :global(.project-dropdown) {
    flex: 1;
  }

  .project-row :global(.no-project-placeholder) {
    flex: 1;
  }

  .new-workspace-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 4px;
  }
</style>
