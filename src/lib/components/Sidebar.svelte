<script lang="ts">
  import { projects, activeWorkspace } from '$lib/stores/projects';
  import { openNewProject, closeProject } from '$lib/services/projectManager';
  import type { Project, Workspace } from '$lib/types/project';
  import CreateWorkspaceDialog from './CreateWorkspaceDialog.svelte';
  import RemoveWorkspaceDialog from './RemoveWorkspaceDialog.svelte';
  import AgentStatusIndicator from './AgentStatusIndicator.svelte';
  import { agentCounts } from '$lib/stores/agentStatus';
  import { createEmptyCounts } from '$lib/types/agentStatus';

  // Create dialog state
  let createDialogProject = $state<Project | null>(null);
  let createTriggerRef = $state<HTMLElement | null>(null);

  // Remove dialog state
  let removeDialogData = $state<{ project: Project; workspace: Workspace } | null>(null);
  let removeTriggerRef = $state<HTMLElement | null>(null);

  function mainWorkspace(project: Project): Workspace {
    return project.workspaces[0];
  }

  function additionalWorktrees(project: Project): Workspace[] {
    return project.workspaces.slice(1);
  }

  function selectWorkspace(project: Project, workspace: Workspace) {
    activeWorkspace.set({
      projectHandle: project.handle,
      workspacePath: workspace.path,
    });
  }

  function handleCloseProject(event: Event, project: Project) {
    event.stopPropagation();
    closeProject(project);
  }

  function openCreateDialog(event: Event, project: Project) {
    event.stopPropagation();
    createTriggerRef = event.currentTarget as HTMLElement;
    createDialogProject = project;
  }

  function handleCreateDialogClose() {
    createDialogProject = null;
  }

  function handleWorkspaceCreated(workspace: Workspace) {
    console.log('Workspace created:', workspace.name);
    createDialogProject = null;
  }

  function openRemoveDialog(event: Event, project: Project, workspace: Workspace) {
    event.stopPropagation();
    removeTriggerRef = event.currentTarget as HTMLElement;
    removeDialogData = { project, workspace };
  }

  function handleRemoveDialogClose() {
    removeDialogData = null;
  }

  function handleWorkspaceRemoved() {
    removeDialogData = null;
  }
</script>

<aside class="sidebar">
  <div class="header">
    <h2>Projects</h2>
  </div>

  <div class="projects-list">
    {#each $projects as project (project.handle)}
      <div class="project-group">
        <div
          class="project-item"
          class:active={$activeWorkspace?.projectHandle === project.handle &&
            $activeWorkspace?.workspacePath === mainWorkspace(project).path}
          onclick={() => selectWorkspace(project, mainWorkspace(project))}
          onkeydown={(e) => e.key === 'Enter' && selectWorkspace(project, mainWorkspace(project))}
          role="button"
          tabindex="0"
        >
          <vscode-icon name="folder" class="icon"></vscode-icon>
          <span class="name">{project.path.split('/').pop()}</span>
          <button
            type="button"
            class="icon-btn add-btn"
            onclick={(e: Event) => openCreateDialog(e, project)}
            title="Create Workspace"
          >
            <vscode-icon name="add"></vscode-icon>
          </button>
          <button
            type="button"
            class="icon-btn close-btn"
            onclick={(e: Event) => handleCloseProject(e, project)}
            title="Close Project"
          >
            <vscode-icon name="close"></vscode-icon>
          </button>
          <AgentStatusIndicator
            counts={$agentCounts.get(mainWorkspace(project).path) ?? createEmptyCounts()}
          />
        </div>

        {#each additionalWorktrees(project) as workspace (workspace.path)}
          <div
            class="workspace-item"
            class:active={$activeWorkspace?.projectHandle === project.handle &&
              $activeWorkspace?.workspacePath === workspace.path}
            onclick={() => selectWorkspace(project, workspace)}
            onkeydown={(e) => e.key === 'Enter' && selectWorkspace(project, workspace)}
            role="button"
            tabindex="0"
          >
            <vscode-icon name="git-branch" class="icon"></vscode-icon>
            <span class="name">{workspace.name}</span>
            <span class="branch">
              {#if workspace.branch}
                ({workspace.branch})
              {:else}
                <span class="detached">(detached)</span>
              {/if}
            </span>
            <button
              type="button"
              class="icon-btn close-btn"
              onclick={(e: Event) => openRemoveDialog(e, project, workspace)}
              title="Remove Workspace"
            >
              <vscode-icon name="close"></vscode-icon>
            </button>
            <AgentStatusIndicator
              counts={$agentCounts.get(workspace.path) ?? createEmptyCounts()}
            />
          </div>
        {/each}
      </div>
    {/each}
  </div>

  <vscode-button class="open-btn" onclick={openNewProject} role="button" tabindex="0">
    Open Project
  </vscode-button>
</aside>

{#if createDialogProject}
  <CreateWorkspaceDialog
    project={createDialogProject}
    onClose={handleCreateDialogClose}
    onCreated={handleWorkspaceCreated}
    triggerElement={createTriggerRef}
  />
{/if}

{#if removeDialogData}
  <RemoveWorkspaceDialog
    project={removeDialogData.project}
    workspace={removeDialogData.workspace}
    onClose={handleRemoveDialogClose}
    onRemoved={handleWorkspaceRemoved}
    triggerElement={removeTriggerRef}
  />
{/if}

<style>
  .sidebar {
    width: clamp(150px, 13vw, 280px);
    height: 100%;
    background: var(--vscode-sideBar-background, #252526);
    color: var(--vscode-sideBar-foreground, #cccccc);
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--vscode-sideBar-border, #3e3e42);
  }

  .header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--vscode-sideBar-border);
  }

  .header h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--vscode-sideBarTitle-foreground, #bbbbbb);
    text-transform: uppercase;
  }

  .projects-list {
    flex: 1;
    overflow-y: auto;
  }

  .project-group {
    margin-bottom: 8px;
  }

  .project-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    cursor: pointer;
    color: var(--vscode-sideBar-foreground, #cccccc);
    user-select: none;
  }

  .project-item:hover {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
  }

  .project-item.active {
    background: var(--vscode-list-activeSelectionBackground, #04395e);
    color: var(--vscode-list-activeSelectionForeground, #ffffff);
  }

  .workspace-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px 4px 32px;
    cursor: pointer;
    color: var(--vscode-sideBar-foreground, #cccccc);
    user-select: none;
    font-size: 12px;
  }

  .workspace-item:hover {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
  }

  .workspace-item.active {
    background: var(--vscode-list-activeSelectionBackground, #04395e);
    color: var(--vscode-list-activeSelectionForeground, #ffffff);
  }

  .icon {
    flex-shrink: 0;
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .branch {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #969696);
  }

  .detached {
    color: var(--vscode-editorWarning-foreground, #cca700);
  }

  .icon-btn {
    flex-shrink: 0;
    background: transparent;
    border: none;
    padding: 2px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.1s;
    display: flex;
    align-items: center;
    justify-content: center;
    color: inherit;
  }

  .project-item:hover .icon-btn,
  .project-item:focus-within .icon-btn,
  .project-item.active .icon-btn,
  .workspace-item:hover .icon-btn,
  .workspace-item:focus-within .icon-btn,
  .workspace-item.active .icon-btn {
    opacity: 1;
  }

  .add-btn:hover {
    color: var(--vscode-textLink-foreground, #3794ff);
  }

  .close-btn:hover {
    color: var(--vscode-errorForeground, #f48771);
  }

  .open-btn {
    margin: 12px;
    width: calc(100% - 24px);
  }
</style>
