<script lang="ts">
  import { projects, activeWorkspace } from '$lib/stores/projects';
  import { openNewProject, closeProject } from '$lib/services/projectManager';
  import type { Project, Workspace } from '$lib/types/project';

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
</script>

<aside class="sidebar">
  <div class="header">
    <h2>Projects</h2>
  </div>

  <div class="projects-list">
    {#each $projects as project (project.handle)}
      <div class="project-group">
        <!-- Project name - clickable, shows main workspace -->
        <div
          class="project-item"
          class:active={$activeWorkspace?.projectHandle === project.handle &&
            $activeWorkspace?.workspacePath === mainWorkspace(project).path}
          on:click={() => selectWorkspace(project, mainWorkspace(project))}
          on:keydown={(e) => e.key === 'Enter' && selectWorkspace(project, mainWorkspace(project))}
          role="button"
          tabindex="0"
        >
          <vscode-icon name="folder" class="icon"></vscode-icon>
          <span class="name">{project.path.split('/').pop()}</span>
          <vscode-icon
            name="close"
            class="close-btn"
            on:click={(e: Event) => handleCloseProject(e, project)}
            role="button"
            tabindex="-1"
          ></vscode-icon>
        </div>

        <!-- Additional worktrees only (exclude main) -->
        {#each additionalWorktrees(project) as workspace}
          <div
            class="workspace-item"
            class:active={$activeWorkspace?.projectHandle === project.handle &&
              $activeWorkspace?.workspacePath === workspace.path}
            on:click={() => selectWorkspace(project, workspace)}
            on:keydown={(e) => e.key === 'Enter' && selectWorkspace(project, workspace)}
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
          </div>
        {/each}
      </div>
    {/each}
  </div>

  <vscode-button class="open-btn" on:click={openNewProject} role="button" tabindex="0">
    Open Project
  </vscode-button>
</aside>

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

  .close-btn {
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.1s;
  }

  .project-item:hover .close-btn,
  .project-item.active .close-btn {
    opacity: 1;
  }

  .close-btn:hover {
    color: var(--vscode-errorForeground, #f48771);
  }

  .open-btn {
    margin: 12px;
    width: calc(100% - 24px);
  }
</style>
