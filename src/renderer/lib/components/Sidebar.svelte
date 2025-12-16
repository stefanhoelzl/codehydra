<script lang="ts" module>
  import type { ProjectWithId } from "$lib/stores/projects.svelte.js";

  /**
   * Calculate the global index of a workspace across all projects.
   * Returns the sum of all workspaces in previous projects plus the workspace index.
   */
  export function getWorkspaceGlobalIndex(
    projects: readonly ProjectWithId[],
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

  /**
   * Generate status text from agent counts for aria-label.
   */
  export function getStatusText(idleCount: number, busyCount: number): string {
    if (idleCount === 0 && busyCount === 0) {
      return "No agents running";
    }
    if (idleCount > 0 && busyCount === 0) {
      const noun = idleCount === 1 ? "agent" : "agents";
      return `${idleCount} ${noun} idle`;
    }
    if (idleCount === 0 && busyCount > 0) {
      const noun = busyCount === 1 ? "agent" : "agents";
      return `${busyCount} ${noun} busy`;
    }
    // mixed
    return `${idleCount} idle, ${busyCount} busy`;
  }
</script>

<script lang="ts">
  import { onDestroy } from "svelte";
  import type { ProjectId, WorkspaceRef, WorkspaceName } from "$lib/api";
  import EmptyState from "./EmptyState.svelte";
  import AgentStatusIndicator from "./AgentStatusIndicator.svelte";
  import { getStatus } from "$lib/stores/agent-status.svelte.js";
  import { isDeleting } from "$lib/stores/deletion.svelte.js";
  import { uiMode, setSidebarExpanded } from "$lib/stores/ui-mode.svelte.js";

  interface SidebarProps {
    projects: readonly ProjectWithId[];
    activeWorkspacePath: string | null;
    loadingState: "loading" | "loaded" | "error";
    loadingError: string | null;
    shortcutModeActive?: boolean;
    totalWorkspaces: number;
    onOpenProject: () => void;
    onCloseProject: (projectId: ProjectId) => void;
    onSwitchWorkspace: (workspaceRef: WorkspaceRef) => void;
    onOpenCreateDialog: (projectId: ProjectId) => void;
    onOpenRemoveDialog: (workspaceRef: WorkspaceRef) => void;
  }

  let {
    projects,
    activeWorkspacePath,
    loadingState,
    loadingError,
    shortcutModeActive = false,
    totalWorkspaces,
    onOpenProject,
    onCloseProject,
    onSwitchWorkspace,
    onOpenCreateDialog,
    onOpenRemoveDialog,
  }: SidebarProps = $props();

  // ============ Expansion State ============

  let isHovering = $state(false);
  let collapseTimeout: ReturnType<typeof setTimeout> | null = null;

  // Sidebar is expanded when:
  // - User is hovering over it, OR
  // - UI mode is not "workspace" (shortcut/dialog mode), OR
  // - There are no workspaces (so user can open a project)
  const isExpanded = $derived(isHovering || uiMode.value !== "workspace" || totalWorkspaces === 0);

  function handleMouseEnter(): void {
    if (collapseTimeout) {
      clearTimeout(collapseTimeout);
      collapseTimeout = null;
    }
    isHovering = true;
    setSidebarExpanded(true);
  }

  function handleMouseLeave(event: MouseEvent): void {
    // Don't collapse if mouse is at the left edge of the window
    // (user likely moved to window boundary, not away from sidebar)
    if (event.clientX < 5) {
      return;
    }

    collapseTimeout = setTimeout(() => {
      isHovering = false;
      setSidebarExpanded(false);
      collapseTimeout = null;
    }, 150); // 150ms debounce
  }

  // Clear hover state when entering shortcut mode (cleanup pending collapse)
  $effect(() => {
    if (shortcutModeActive && collapseTimeout) {
      clearTimeout(collapseTimeout);
      collapseTimeout = null;
    }
  });

  // Clean up timeout on component destroy
  onDestroy(() => {
    if (collapseTimeout) {
      clearTimeout(collapseTimeout);
    }
  });

  // ============ Actions ============

  function handleAddWorkspace(projectId: ProjectId): void {
    onOpenCreateDialog(projectId);
  }

  function handleRemoveWorkspace(workspaceRef: WorkspaceRef): void {
    onOpenRemoveDialog(workspaceRef);
  }
</script>

<nav
  class="sidebar"
  class:expanded={isExpanded}
  aria-label="Projects"
  onmouseenter={handleMouseEnter}
  onmouseleave={handleMouseLeave}
>
  <header class="sidebar-header">
    {#if !isExpanded}
      <span class="expand-hint" aria-hidden="true">
        <span class="chevron">&#9656;</span>
      </span>
    {/if}
    <h2>PROJECTS</h2>
  </header>

  <div class="sidebar-content">
    {#if loadingState === "loading"}
      <div class="loading-state" role="status">
        <vscode-progress-ring class="loading-spinner"></vscode-progress-ring>
        Loading projects...
      </div>
    {:else if loadingState === "error"}
      <div class="error-state" role="alert">
        <p>{loadingError ?? "An error occurred"}</p>
      </div>
    {:else if projects.length === 0}
      <EmptyState />
    {:else}
      <ul class="project-list">
        {#each projects as project, projectIndex (project.path)}
          {#if projectIndex > 0}
            <vscode-divider></vscode-divider>
          {/if}
          <li class="project-item">
            <div class="project-header">
              <span class="project-name" title={project.path}>{project.name}</span>
              <div class="project-actions">
                <button
                  type="button"
                  class="action-btn"
                  id={`add-ws-${project.id}`}
                  aria-label="Add workspace"
                  onclick={() => handleAddWorkspace(project.id)}
                >
                  +
                </button>
                <button
                  type="button"
                  class="action-btn"
                  id={`close-project-${project.id}`}
                  aria-label="Close project"
                  onclick={() => onCloseProject(project.id)}
                >
                  &times;
                </button>
              </div>
            </div>
            <ul class="workspace-list">
              {#each project.workspaces as workspace, workspaceIndex (workspace.path)}
                {@const globalIndex = getWorkspaceGlobalIndex(
                  projects,
                  projectIndex,
                  workspaceIndex
                )}
                {@const displayIndex = formatIndexDisplay(globalIndex)}
                {@const shortcutHint = getShortcutHint(globalIndex)}
                {@const agentStatus = getStatus(workspace.path)}
                {@const statusText = getStatusText(
                  agentStatus.counts.idle,
                  agentStatus.counts.busy
                )}
                {@const isActive = workspace.path === activeWorkspacePath}
                {@const workspaceIsDeleting = isDeleting(workspace.path)}
                {@const workspaceRef = {
                  projectId: project.id,
                  workspaceName: workspace.name as WorkspaceName,
                  path: workspace.path,
                }}
                {#if isExpanded}
                  <!-- Expanded layout: original sidebar layout -->
                  <li
                    class="workspace-item"
                    class:active={isActive}
                    aria-current={isActive ? "true" : undefined}
                  >
                    <button
                      type="button"
                      class="workspace-btn"
                      aria-label={workspace.name + (shortcutModeActive ? shortcutHint : "")}
                      onclick={() => onSwitchWorkspace(workspaceRef)}
                    >
                      {#if shortcutModeActive}
                        <vscode-badge
                          class="shortcut-badge"
                          class:badge-dimmed={displayIndex === null}
                          aria-hidden="true"
                        >
                          {displayIndex ?? "·"}
                        </vscode-badge>
                      {/if}
                      {workspace.name}
                    </button>
                    <button
                      type="button"
                      class="action-btn remove-btn"
                      id={`remove-ws-${workspace.path}`}
                      aria-label="Remove workspace"
                      onclick={() => handleRemoveWorkspace(workspaceRef)}
                    >
                      &times;
                    </button>
                    {#if workspaceIsDeleting}
                      <vscode-progress-ring class="deletion-spinner"></vscode-progress-ring>
                    {:else}
                      <AgentStatusIndicator
                        idleCount={agentStatus.counts.idle}
                        busyCount={agentStatus.counts.busy}
                      />
                    {/if}
                  </li>
                {:else}
                  <!-- Minimized layout: clickable status indicators -->
                  <!-- Workspace name kept in DOM (visually hidden) for accessibility -->
                  <li
                    class="workspace-item-minimized"
                    class:active={isActive}
                    aria-current={isActive ? "true" : undefined}
                  >
                    <button
                      type="button"
                      class="status-indicator-btn"
                      aria-label={`${workspace.name} in ${project.name} - ${workspaceIsDeleting ? "Deleting" : statusText}`}
                      aria-current={isActive ? "true" : undefined}
                      onclick={() => onSwitchWorkspace(workspaceRef)}
                    >
                      {#if workspaceIsDeleting}
                        <vscode-progress-ring class="deletion-spinner"></vscode-progress-ring>
                      {:else}
                        <AgentStatusIndicator
                          idleCount={agentStatus.counts.idle}
                          busyCount={agentStatus.counts.busy}
                        />
                      {/if}
                      <span class="ch-visually-hidden">{workspace.name}</span>
                    </button>
                  </li>
                {/if}
              {/each}
            </ul>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="sidebar-footer">
    {#if !isExpanded}
      <span class="expand-hint" aria-hidden="true">
        <span class="chevron">&#9656;</span>
      </span>
    {/if}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <vscode-button
      class="open-project-btn"
      aria-label={"Open Project" + (shortcutModeActive ? " - Press O" : "")}
      onclick={onOpenProject}
    >
      {#if shortcutModeActive}
        <vscode-badge class="shortcut-badge" aria-hidden="true">O</vscode-badge>
      {/if}
      Open Project
    </vscode-button>
  </div>
</nav>

<style>
  .sidebar {
    position: absolute;
    left: 0;
    top: 0;
    /* Minimized: show only left 20px, expanded: full width */
    width: var(--ch-sidebar-minimized-width, 20px);
    height: 100%;
    background: var(--ch-background);
    color: var(--ch-foreground);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition:
      width var(--ch-sidebar-transition, 150ms ease-out),
      box-shadow var(--ch-sidebar-transition, 150ms ease-out);
    z-index: var(--ch-z-sidebar-minimized, 1);
    pointer-events: auto;
  }

  .sidebar.expanded {
    width: var(--ch-sidebar-width, 250px);
    z-index: var(--ch-z-sidebar-expanded, 50);
    box-shadow: var(--ch-shadow);
    overflow-y: auto;
  }

  @media (prefers-reduced-motion: reduce) {
    .sidebar {
      transition: none;
    }
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    padding: 12px 16px 12px 12px;
    border-bottom: 1px solid var(--ch-input-border);
    gap: 0;
    min-width: var(--ch-sidebar-width, 250px);
  }

  /* When minimized, expand-hint takes up left space */
  .sidebar-header:has(.expand-hint) {
    padding-left: 0;
  }

  .expand-hint {
    width: var(--ch-sidebar-minimized-width, 20px);
    min-width: var(--ch-sidebar-minimized-width, 20px);
    height: 32px;
    opacity: 0.5;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .expand-hint:hover {
    opacity: 1;
  }

  .chevron {
    font-size: 12px; /* Minimum 12px for accessibility */
    line-height: 1;
  }

  .sidebar-header h2 {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0;
    margin-left: 8px;
    opacity: 0.7;
    flex: 1;
    white-space: nowrap;
  }

  .loading-state,
  .error-state {
    padding: 20px;
    text-align: center;
  }

  .loading-spinner {
    margin-right: 8px;
    vertical-align: middle;
  }

  .error-state {
    color: var(--ch-error-fg);
  }

  .sidebar-content {
    flex: 1;
    overflow-y: auto;
    min-width: var(--ch-sidebar-width, 250px);
  }

  .project-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .project-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px 8px calc(var(--ch-sidebar-minimized-width, 20px) + 8px);
    gap: 8px;
    min-width: var(--ch-sidebar-width, 250px);
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
    padding: 4px 12px 4px 12px;
    gap: 4px;
    min-height: 44px; /* Accessible click target */
    min-width: var(--ch-sidebar-width, 250px);
  }

  .status-indicator-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--ch-sidebar-minimized-width, 20px);
    min-width: var(--ch-sidebar-minimized-width, 20px);
    min-height: 36px;
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 4px;
    flex-shrink: 0;
    border-radius: 2px;
  }

  .status-indicator-btn:hover {
    background: var(--ch-input-bg);
  }

  .status-indicator-btn:focus {
    outline: 1px solid var(--ch-focus-border);
    outline-offset: -1px;
  }

  .workspace-item.active {
    background: var(--ch-list-active-bg);
  }

  .workspace-item:hover {
    background: var(--ch-input-bg);
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

  .workspace-item .remove-btn {
    opacity: 0;
  }

  .workspace-item:hover .remove-btn,
  .workspace-item:focus-within .remove-btn {
    opacity: 0.7;
  }

  /* Minimized layout: only status indicator visible */
  .workspace-item-minimized {
    display: flex;
    align-items: center;
    min-height: 44px; /* Accessible click target */
  }

  .workspace-item-minimized.active .status-indicator-btn {
    background: rgba(255, 255, 255, 0.1);
  }

  .sidebar-footer {
    display: flex;
    align-items: center;
    padding: 12px 16px 12px 12px;
    border-top: 1px solid var(--ch-input-border);
    gap: 0;
    min-width: var(--ch-sidebar-width, 250px);
  }

  /* When minimized, expand-hint takes up left space */
  .sidebar-footer:has(.expand-hint) {
    padding-left: 0;
  }

  .open-project-btn {
    flex: 1;
    margin-left: 8px;
  }

  .shortcut-badge {
    margin-right: 0.25rem;
  }

  .badge-dimmed {
    opacity: 0.4;
  }

  .deletion-spinner {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }
</style>
