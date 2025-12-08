<script lang="ts" module>
  import type { Project } from "$lib/api";

  /**
   * Calculate the global index of a workspace across all projects.
   * Returns the sum of all workspaces in previous projects plus the workspace index.
   */
  export function getWorkspaceGlobalIndex(
    projects: readonly Project[],
    projectIndex: number,
    workspaceIndex: number
  ): number {
    let globalIndex = 0;
    for (let p = 0; p < projectIndex; p++) {
      globalIndex += projects[p]?.workspaces.length ?? 0;
    }
    return globalIndex + workspaceIndex;
  }

  /**
   * Format a global index as a shortcut key display.
   * Returns "1"-"9" for indices 0-8, "0" for index 9, null for 10+.
   */
  export function formatIndexDisplay(globalIndex: number): string | null {
    if (globalIndex > 9) return null; // No shortcut for 11+
    return globalIndex === 9 ? "0" : String(globalIndex + 1);
  }

  /**
   * Get the shortcut hint for a workspace at a given global index.
   */
  export function getShortcutHint(globalIndex: number): string {
    if (globalIndex > 9) return ""; // No shortcut
    const key = globalIndex === 9 ? "0" : String(globalIndex + 1);
    return ` - Press ${key} to jump`;
  }
</script>

<script lang="ts">
  import type { ProjectPath } from "$lib/api";
  import EmptyState from "./EmptyState.svelte";
  import AgentStatusIndicator from "./AgentStatusIndicator.svelte";
  import { getStatus } from "$lib/stores/agent-status.svelte.js";

  interface SidebarProps {
    projects: readonly Project[];
    activeWorkspacePath: string | null;
    loadingState: "loading" | "loaded" | "error";
    loadingError: string | null;
    shortcutModeActive?: boolean;
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
    shortcutModeActive = false,
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
    <EmptyState {onOpenProject} {shortcutModeActive} />
  {:else}
    <ul class="project-list">
      {#each projects as project, projectIndex (project.path)}
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
            {#each project.workspaces as workspace, workspaceIndex (workspace.path)}
              {@const globalIndex = getWorkspaceGlobalIndex(projects, projectIndex, workspaceIndex)}
              {@const displayIndex = formatIndexDisplay(globalIndex)}
              {@const shortcutHint = getShortcutHint(globalIndex)}
              {@const agentStatus = getStatus(workspace.path)}
              <li
                class="workspace-item"
                class:active={workspace.path === activeWorkspacePath}
                aria-current={workspace.path === activeWorkspacePath ? "true" : undefined}
              >
                <button
                  type="button"
                  class="workspace-btn"
                  aria-label={workspace.name + (shortcutModeActive ? shortcutHint : "")}
                  onclick={() => onSwitchWorkspace(workspace.path)}
                >
                  {#if shortcutModeActive}
                    <span
                      class="shortcut-index"
                      class:shortcut-index--dimmed={displayIndex === null}
                      aria-hidden="true"
                    >
                      {displayIndex ?? "·"}
                    </span>
                  {/if}
                  {workspace.name}
                </button>
                <AgentStatusIndicator
                  idleCount={agentStatus.counts.idle}
                  busyCount={agentStatus.counts.busy}
                />
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
      <button
        type="button"
        class="open-project-btn"
        aria-label={"Open Project" + (shortcutModeActive ? " - Press O" : "")}
        onclick={onOpenProject}
      >
        {#if shortcutModeActive}
          <span class="shortcut-index" aria-hidden="true">O</span>
        {/if}
        Open Project
      </button>
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

  .workspace-item:focus-within {
    outline: 1px solid var(--ch-focus-border);
    outline-offset: -1px;
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

  .shortcut-index {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    margin-right: 0.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--ch-button-fg);
    background: var(--ch-button-bg);
    border-radius: 2px;
  }

  .shortcut-index--dimmed {
    opacity: 0.4;
  }
</style>
