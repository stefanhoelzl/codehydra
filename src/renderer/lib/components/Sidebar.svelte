<script lang="ts">
  import type { Project, ProjectPath } from "$lib/api";
  import EmptyState from "./EmptyState.svelte";

  interface SidebarProps {
    projects: readonly Project[];
    activeWorkspacePath: string | null;
    loadingState: "loading" | "loaded" | "error";
    loadingError: string | null;
    onOpenProject: () => void;
    onCloseProject: (path: ProjectPath) => void;
    onSwitchWorkspace: (path: string) => void;
    onOpenCreateDialog: (projectPath: string, triggerId: string) => void;
    onOpenRemoveDialog: (workspacePath: string, triggerId: string) => void;
  }

  let {
    projects,
    activeWorkspacePath,
    loadingState,
    loadingError,
    onOpenProject,
    onCloseProject,
    onSwitchWorkspace,
    onOpenCreateDialog,
    onOpenRemoveDialog,
  }: SidebarProps = $props();

  function handleAddWorkspace(projectPath: ProjectPath): void {
    const triggerId = `add-ws-${projectPath}`;
    onOpenCreateDialog(projectPath, triggerId);
  }

  function handleRemoveWorkspace(workspacePath: string): void {
    const triggerId = `remove-ws-${workspacePath}`;
    onOpenRemoveDialog(workspacePath, triggerId);
  }
</script>

<nav class="sidebar" aria-label="Projects">
  <header class="sidebar-header">
    <h2>PROJECTS</h2>
  </header>

  {#if loadingState === "loading"}
    <div class="loading-state" role="status">
      <span class="loading-spinner">&#9673;</span> Loading projects...
    </div>
  {:else if loadingState === "error"}
    <div class="error-state" role="alert">
      <p>{loadingError ?? "An error occurred"}</p>
    </div>
  {:else if projects.length === 0}
    <EmptyState {onOpenProject} />
  {:else}
    <ul class="project-list">
      {#each projects as project (project.path)}
        <li class="project-item">
          <div class="project-header">
            <span class="project-name" title={project.path}>{project.name}</span>
            <div class="project-actions">
              <button
                type="button"
                class="action-btn"
                id={`add-ws-${project.path}`}
                aria-label="Add workspace"
                onclick={() => handleAddWorkspace(project.path)}
              >
                +
              </button>
              <button
                type="button"
                class="action-btn"
                id={`close-project-${project.path}`}
                aria-label="Close project"
                onclick={() => onCloseProject(project.path)}
              >
                &times;
              </button>
            </div>
          </div>
          <ul class="workspace-list">
            {#each project.workspaces as workspace (workspace.path)}
              <li
                class="workspace-item"
                class:active={workspace.path === activeWorkspacePath}
                aria-current={workspace.path === activeWorkspacePath ? "true" : undefined}
              >
                <button
                  type="button"
                  class="workspace-btn"
                  onclick={() => onSwitchWorkspace(workspace.path)}
                >
                  {workspace.name}
                </button>
                <button
                  type="button"
                  class="action-btn remove-btn"
                  id={`remove-ws-${workspace.path}`}
                  aria-label="Remove workspace"
                  onclick={() => handleRemoveWorkspace(workspace.path)}
                >
                  &times;
                </button>
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
    <div class="sidebar-footer">
      <button type="button" class="open-project-btn" onclick={onOpenProject}> Open Project </button>
    </div>
  {/if}
</nav>

<style>
  .sidebar {
    width: var(--ch-sidebar-width, 250px);
    height: 100%;
    background: var(--ch-background);
    color: var(--ch-foreground);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  .sidebar-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--ch-input-border);
  }

  .sidebar-header h2 {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0;
    opacity: 0.7;
  }

  .loading-state,
  .error-state {
    padding: 20px;
    text-align: center;
  }

  .loading-spinner {
    animation: spin 1s linear infinite;
    display: inline-block;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .error-state {
    color: var(--ch-error-fg);
  }

  .project-list {
    list-style: none;
    padding: 0;
    margin: 0;
    flex: 1;
  }

  .project-item {
    border-bottom: 1px solid var(--ch-input-border);
  }

  .project-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    gap: 8px;
  }

  .project-name {
    font-weight: 600;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-actions {
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .project-header:hover .project-actions,
  .project-header:focus-within .project-actions {
    opacity: 1;
  }

  .action-btn {
    background: transparent;
    border: none;
    color: var(--ch-foreground);
    cursor: pointer;
    padding: 2px 6px;
    font-size: 14px;
    opacity: 0.7;
    border-radius: 2px;
  }

  .action-btn:hover {
    opacity: 1;
    background: var(--ch-input-bg);
  }

  .workspace-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .workspace-item {
    display: flex;
    align-items: center;
    padding: 4px 12px 4px 24px;
    gap: 8px;
  }

  .workspace-item.active {
    background: var(--ch-list-active-bg);
  }

  .workspace-btn {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--ch-foreground);
    cursor: pointer;
    text-align: left;
    padding: 4px 8px;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-radius: 2px;
  }

  .workspace-btn:hover {
    background: var(--ch-input-bg);
  }

  .workspace-item .remove-btn {
    opacity: 0;
  }

  .workspace-item:hover .remove-btn,
  .workspace-item:focus-within .remove-btn {
    opacity: 0.7;
  }

  .sidebar-footer {
    padding: 12px 16px;
    border-top: 1px solid var(--ch-input-border);
  }

  .open-project-btn {
    width: 100%;
    background: var(--ch-button-bg);
    color: var(--ch-button-fg);
    border: none;
    padding: 8px 16px;
    cursor: pointer;
    border-radius: 2px;
  }

  .open-project-btn:hover {
    opacity: 0.9;
  }
</style>
