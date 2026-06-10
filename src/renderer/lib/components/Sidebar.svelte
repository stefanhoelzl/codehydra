<script lang="ts">
  import { onDestroy } from "svelte";
  import * as api from "$lib/api";
  import type { ProjectId, WorkspaceRef, WorkspaceName } from "$lib/api";
  import AgentStatusIndicator from "./AgentStatusIndicator.svelte";
  import WorkspaceTags from "./WorkspaceTags.svelte";
  import Icon from "./Icon.svelte";
  import NotificationStack from "./NotificationStack.svelte";
  import { extractTags } from "@shared/api/types";
  import { getCounts } from "$lib/stores/agent-status.svelte.js";
  import { getDeletionStatus } from "$lib/stores/deletion.svelte.js";
  import { isPending } from "$lib/stores/pending-workspaces.svelte.js";
  import {
    desiredMode,
    hoverExpansionEligible,
    setSidebarExpanded,
  } from "$lib/stores/ui-mode.svelte.js";
  import {
    getWorkspaceGlobalIndex,
    formatIndexDisplay,
    getShortcutHint,
    getStatusText,
  } from "$lib/utils/sidebar-utils.js";
  import { createLogger } from "$lib/logging";
  import type { Project } from "$lib/api";

  const logger = createLogger("ui");

  interface SidebarProps {
    projects: readonly Project[];
    activeWorkspacePath: string | null;
    shortcutModeActive?: boolean;
    totalWorkspaces: number;
    /** When true, the New workspace view is the current tab (highlight it instead of any workspace). */
    newWorkspaceViewOpen?: boolean;
    onCloseProject: (projectId: ProjectId) => void;
    onSwitchWorkspace: (workspaceRef: WorkspaceRef) => void;
    onOpenNewWorkspace: () => void;
    onOpenRemoveDialog: (workspaceRef: WorkspaceRef) => void;
  }

  let {
    projects,
    activeWorkspacePath,
    shortcutModeActive = false,
    totalWorkspaces,
    newWorkspaceViewOpen = false,
    onCloseProject,
    onSwitchWorkspace,
    onOpenNewWorkspace,
    onOpenRemoveDialog,
  }: SidebarProps = $props();

  // ============ Expansion State ============

  /** Debounce for both arming expansion (deliberate-hover filter) and collapsing. */
  const HOVER_DELAY_MS = 150;
  /**
   * Hover only arms expansion once the cursor has penetrated the collapsed
   * gutter past the outer quarter; shallow grazes along its outer edge are
   * ignored.
   */
  const HOVER_TRIGGER_DEPTH_PX = 15;

  let isHovering = false;
  let openTimeout: ReturnType<typeof setTimeout> | null = null;
  let collapseTimeout: ReturnType<typeof setTimeout> | null = null;

  // Sidebar is expanded when:
  // - any ui-mode input forces the UI on top (hover, shortcut, dialog, New workspace view), OR
  // - there are no workspaces (so user can open a project)
  const isExpanded = $derived(desiredMode.value !== "workspace" || totalWorkspaces === 0);

  function clearOpenTimeout(): void {
    if (openTimeout) {
      clearTimeout(openTimeout);
      openTimeout = null;
    }
  }

  function clearCollapseTimeout(): void {
    if (collapseTimeout) {
      clearTimeout(collapseTimeout);
      collapseTimeout = null;
    }
  }

  function maybeArmExpansion(clientX: number): void {
    if (isHovering) return;
    // Hover may only initiate expansion when nothing else forces the UI on
    // top; otherwise the sidebar expanding into a parked cursor would latch
    // hover and keep the sidebar open after that mode exits.
    if (!hoverExpansionEligible.value) {
      logger.debug("sidebar hover: not eligible", { clientX });
      return;
    }
    if (clientX > HOVER_TRIGGER_DEPTH_PX) {
      if (openTimeout) logger.debug("sidebar hover: disarm (shallow)", { clientX });
      clearOpenTimeout();
      return;
    }
    if (!openTimeout) {
      logger.debug("sidebar hover: arm", { clientX });
      openTimeout = setTimeout(() => {
        openTimeout = null;
        if (!hoverExpansionEligible.value) return;
        logger.debug("sidebar hover: expand");
        isHovering = true;
        setSidebarExpanded(true);
      }, HOVER_DELAY_MS);
    }
  }

  function handleMouseEnter(event: MouseEvent): void {
    logger.debug("sidebar hover: enter", { clientX: event.clientX, isHovering });
    clearCollapseTimeout();
    // A cursor slammed against the window edge can come to rest in the same
    // frame it enters — no mousemove ever fires, so arm from the enter too.
    maybeArmExpansion(event.clientX);
  }

  function handleMouseMove(event: MouseEvent): void {
    maybeArmExpansion(event.clientX);
  }

  function pinnedAgainstScreenEdge(): boolean {
    // An exit through our left boundary can only be a "pin" when the
    // window's left edge sits at the screen's left edge; otherwise the
    // cursor genuinely left the window (windowed mode) and a normal leave
    // applies. (Under native Wayland window positions report 0, degrading
    // to treating every left exit as a pin.)
    const availLeft = (window.screen as Screen & { availLeft?: number }).availLeft ?? 0;
    return window.screenX <= availLeft;
  }

  function handleMouseLeave(event: MouseEvent): void {
    // A leave through the left boundary while the window sits at the screen
    // edge means the cursor is pinned: the OS keeps the pointer there but
    // reports it just outside, and NO further events arrive while it rests
    // (a fast slam delivers only a shallow enter + this leave). Treat it as
    // the deepest possible hover — arm expansion / keep the sidebar open —
    // not as a leave.
    if (event.clientX <= 0 && pinnedAgainstScreenEdge()) {
      logger.debug("sidebar hover: edge pin", { clientX: event.clientX, isHovering });
      maybeArmExpansion(0);
      return;
    }
    logger.debug("sidebar hover: leave", { clientX: event.clientX, isHovering });
    clearOpenTimeout();
    if (!isHovering) return;
    collapseTimeout ??= setTimeout(() => {
      collapseTimeout = null;
      logger.debug("sidebar hover: collapse");
      isHovering = false;
      setSidebarExpanded(false);
    }, HOVER_DELAY_MS);
  }

  // Clean up timeouts on component destroy
  onDestroy(() => {
    clearOpenTimeout();
    clearCollapseTimeout();
  });

  // ============ Actions ============

  function handleRemoveWorkspace(workspaceRef: WorkspaceRef): void {
    onOpenRemoveDialog(workspaceRef);
  }

  function handleWakeWorkspace(path: string): void {
    api.workspaces.wake(path).catch((error: unknown) => {
      logger.error("Failed to wake workspace", { path, error: String(error) });
    });
  }
</script>

<!--
  Two-column row layout: every row is [flexible label cell | fixed icon cell
  at the right edge]. Collapsing the sidebar shrinks the label cells to zero
  width, so the icon column IS the collapsed sidebar.
-->
<nav
  class="sidebar"
  class:expanded={isExpanded}
  class:ch-sidebar-expanded={isExpanded}
  aria-label="Projects"
  onmouseenter={handleMouseEnter}
  onmousemove={handleMouseMove}
  onmouseleave={handleMouseLeave}
>
  <header class="sidebar-header">
    <div class="ch-label-cell header-label">
      <h2>PROJECTS</h2>
    </div>
    {#if !isExpanded}
      <span class="ch-icon-cell expand-hint" aria-hidden="true">
        <Icon name="chevron-right" size={12} />
      </span>
    {/if}
  </header>

  <div class="sidebar-content">
    <!-- Global "New workspace" entry, pinned above the projects. -->
    <button
      type="button"
      class="new-workspace-entry"
      class:active={newWorkspaceViewOpen}
      aria-label="New workspace"
      aria-current={newWorkspaceViewOpen ? "true" : undefined}
      onclick={() => onOpenNewWorkspace()}
    >
      <span class="ch-label-cell new-workspace-label-cell">
        <span class="new-workspace-label">New workspace</span>
      </span>
      <span class="ch-icon-cell new-workspace-icon"><Icon name="add" size={14} /></span>
    </button>

    <ul class="project-list">
      {#each projects as project, projectIndex (project.path)}
        {#if projectIndex > 0}
          <vscode-divider></vscode-divider>
        {/if}
        {@const projectTitle = project.remoteUrl ?? project.path}
        <li class="project-item">
          <div class="project-header ch-label-cell">
            <span class="project-icon" title={projectTitle}>
              <Icon name={project.remoteUrl ? "source-control" : "folder-opened"} size={14} />
            </span>
            <span class="project-name" title={projectTitle}>{project.name}</span>
            <div class="project-actions">
              <button
                type="button"
                class="action-btn"
                id={`close-project-${project.id}`}
                aria-label="Close project"
                onclick={() => onCloseProject(project.id)}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          </div>
          <ul class="workspace-list">
            {#each project.workspaces as workspace, workspaceIndex (workspace.path)}
              {@const globalIndex = getWorkspaceGlobalIndex(projects, projectIndex, workspaceIndex)}
              {@const displayIndex = formatIndexDisplay(globalIndex)}
              {@const shortcutHint = getShortcutHint(globalIndex)}
              {@const agentCounts = getCounts(workspace.path)}
              {@const statusText = getStatusText(agentCounts.idle, agentCounts.busy)}
              {@const isActive = workspace.path === activeWorkspacePath}
              {@const deletionStatus = getDeletionStatus(workspace.path)}
              {@const workspaceRef = {
                projectId: project.id,
                workspaceName: workspace.name as WorkspaceName,
                path: workspace.path,
              }}
              {@const hasTags = workspace.metadata
                ? extractTags(workspace.metadata).length > 0
                : false}
              {@const pending = isPending(workspace.path)}
              {@const hibernated = workspace.metadata?.["hibernated"] === "true"}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
              <li
                class="workspace-item"
                class:active={isActive}
                class:has-tags={hasTags}
                class:hibernated
                aria-current={isActive ? "true" : undefined}
                onclick={() => {
                  if (!pending) onSwitchWorkspace(workspaceRef);
                }}
              >
                <div class="workspace-row">
                  <div class="ch-label-cell workspace-label-cell">
                    <button
                      type="button"
                      class="workspace-btn"
                      aria-label={workspace.name + (shortcutModeActive ? shortcutHint : "")}
                    >
                      {#if shortcutModeActive && !hibernated}
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
                    {#if !pending && deletionStatus === "none"}
                      <button
                        type="button"
                        class="action-btn remove-btn"
                        id={`remove-ws-${workspace.path}`}
                        aria-label="Remove workspace"
                        onclick={(e) => {
                          e.stopPropagation();
                          handleRemoveWorkspace(workspaceRef);
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    {/if}
                  </div>
                  <!-- Status cell: a button in both modes (clicks bubble to the
                       row's switch handler); the collapsed sidebar shows only
                       this cell. For hibernated workspaces it also wakes —
                       the click bubbles on, so the row switches too. -->
                  <button
                    type="button"
                    class="ch-icon-cell status-cell"
                    aria-label={`${workspace.name} in ${project.name} - ${pending ? "Creating" : deletionStatus === "in-progress" ? "Deleting" : deletionStatus === "error" ? "Deletion failed" : hibernated ? "Hibernated - click to wake" : statusText}`}
                    aria-current={isActive ? "true" : undefined}
                    onclick={() => {
                      if (hibernated) handleWakeWorkspace(workspace.path);
                    }}
                  >
                    {#if pending}
                      <!-- Creating: show red "busy" immediately (work is queued) -->
                      <AgentStatusIndicator idleCount={0} busyCount={1} />
                    {:else if deletionStatus === "in-progress"}
                      <vscode-progress-ring class="deletion-spinner"></vscode-progress-ring>
                    {:else if deletionStatus === "error"}
                      <span class="deletion-error" role="img" aria-label="Deletion failed">
                        <Icon name="warning" size={14} />
                      </span>
                    {:else if hibernated}
                      <span class="hibernation-indicator" role="img" aria-label="Hibernated">
                        <span class="icon-pause"><Icon name="debug-pause" size={14} /></span>
                        <span class="icon-play"><Icon name="debug-start" size={14} /></span>
                      </span>
                    {:else}
                      <AgentStatusIndicator
                        idleCount={agentCounts.idle}
                        busyCount={agentCounts.busy}
                      />
                    {/if}
                  </button>
                </div>
                {#if hasTags}
                  <div class="workspace-tags-row">
                    <WorkspaceTags metadata={workspace.metadata} />
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  </div>

  <NotificationStack {isExpanded} />
</nav>

<style>
  .sidebar {
    position: absolute;
    left: 0;
    top: 0;
    /* Minimized: show only the icon column, expanded: full width */
    width: var(--ch-sidebar-minimized-width, 20px);
    height: 100%;
    background: var(--ch-surface-1, var(--ch-background));
    color: var(--ch-foreground);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition:
      width var(--ch-sidebar-transition, 150ms ease-out),
      box-shadow var(--ch-sidebar-transition, 150ms ease-out);
    z-index: var(--ch-z-sidebar-minimized, 1);
    pointer-events: auto;
    user-select: none;
  }

  /* Collapse snaps instead of animating: collapsing also drops the UI view
     below the workspace views (native z-order, instant), which covers
     everything beyond the gutter — an animated slide would only be visible
     as the icons popping in at the end. */
  .sidebar:not(.expanded) {
    transition: none;
  }

  .sidebar.expanded {
    width: var(--ch-sidebar-width, 250px);
    z-index: var(--ch-z-sidebar-expanded, 50);
    box-shadow: var(--ch-shadow);
  }

  /* Two-column row cells: .ch-icon-cell / .ch-label-cell come from global.css. */

  /* Shrink-to-zero zones inside two-column rows. Inner content keeps its own
     spacing and is clipped while the width animates. */
  .header-label,
  .new-workspace-label-cell,
  .workspace-label-cell {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    align-items: center;
    overflow: hidden;
  }

  @media (prefers-reduced-motion: reduce) {
    .sidebar {
      transition: none;
    }
  }

  /* ============ Header ============ */

  .sidebar-header {
    display: flex;
    align-items: center;
    padding: 12px 0;
    border-bottom: 1px solid var(--ch-input-border);
  }

  .expand-hint {
    opacity: 0.5;
    align-self: stretch;
  }

  .expand-hint:hover {
    opacity: 1;
  }

  .sidebar-header h2 {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0 0 0 20px;
    opacity: 0.7;
    white-space: nowrap;
  }

  .sidebar-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  /* ============ New workspace entry ============ */

  .new-workspace-entry {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 36px;
    padding: 4px 0;
    background: transparent;
    border: none;
    color: var(--ch-foreground);
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    text-align: left;
  }

  .new-workspace-entry:hover {
    background: var(--ch-list-hover-bg);
  }

  .new-workspace-entry:focus-visible {
    outline: 1px solid var(--ch-focus-border);
    outline-offset: -1px;
  }

  .new-workspace-entry.active {
    background: var(--ch-accent-muted, var(--ch-list-active-bg));
    color: var(--ch-list-active-fg);
    position: relative;
  }

  .new-workspace-entry.active::before {
    content: "";
    position: absolute;
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 3px;
    border-radius: 0 2px 2px 0;
    background: var(--ch-focus-border);
  }

  .new-workspace-label {
    margin-left: 28px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .new-workspace-icon {
    opacity: 0.8;
  }

  .new-workspace-entry:hover .new-workspace-icon,
  .new-workspace-entry.active .new-workspace-icon {
    opacity: 1;
  }

  /* ============ Projects ============ */

  .project-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .project-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 12px 4px 28px;
    gap: 8px;
  }

  .project-icon {
    opacity: 0.7;
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .project-name {
    flex: 1;
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
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: var(--ch-foreground);
    cursor: pointer;
    padding: 2px 6px;
    opacity: 0.7;
    border-radius: var(--ch-radius-sm, 6px);
  }

  .action-btn:hover {
    opacity: 1;
    background: var(--ch-list-hover-bg);
  }

  /* ============ Workspaces ============ */

  .workspace-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .workspace-item {
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 4px 0;
    min-height: 44px; /* Accessible click target */
    cursor: pointer;
    border-radius: var(--ch-radius-sm, 6px);
    position: relative;
  }

  .sidebar.expanded .workspace-item.has-tags {
    padding-bottom: 6px;
  }

  .workspace-row {
    display: flex;
    align-items: center;
  }

  .workspace-btn {
    flex: 1 1 0;
    min-width: 0;
    background: transparent;
    border: none;
    color: var(--ch-foreground);
    cursor: pointer;
    text-align: left;
    padding: 4px 8px 4px 20px;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-radius: var(--ch-radius-sm, 6px);
  }

  .status-cell {
    min-height: 36px;
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 4px;
    border-radius: var(--ch-radius-sm, 6px);
  }

  .status-cell:hover {
    background: var(--ch-list-hover-bg);
  }

  .status-cell:focus-visible {
    outline: 1px solid var(--ch-focus-border);
    outline-offset: -1px;
  }

  .workspace-item.active {
    background: var(--ch-accent-muted, var(--ch-list-active-bg));
    color: var(--ch-list-active-fg);
  }

  .workspace-item.active::before {
    content: "";
    position: absolute;
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 3px;
    border-radius: 0 2px 2px 0;
    background: var(--ch-focus-border);
  }

  .workspace-item.active .workspace-btn {
    color: inherit;
  }

  .workspace-item:hover {
    background: var(--ch-list-hover-bg);
  }

  .workspace-item.active:hover {
    background: var(--ch-list-active-bg);
  }

  /* Keyboard-only: mouse clicks focus the inner buttons too, and the active
     row highlight already covers that case. */
  .workspace-item:has(:focus-visible) {
    outline: 1px solid var(--ch-focus-border);
    outline-offset: -1px;
  }

  .workspace-item .remove-btn {
    opacity: 0;
  }

  .workspace-item:hover .remove-btn,
  .workspace-item:focus-within .remove-btn {
    opacity: 0.7;
  }

  .workspace-tags-row {
    padding-left: 12px;
  }

  .sidebar:not(.expanded) .workspace-tags-row {
    display: none;
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

  .deletion-error {
    --vscode-icon-foreground: var(--ch-danger);
    font-size: 14px;
    flex-shrink: 0;
  }

  .hibernation-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.55;
    flex-shrink: 0;
  }

  /* Pause at rest, play while hovering the status cell (= "click to wake"). */
  .hibernation-indicator .icon-pause {
    display: flex;
  }

  .hibernation-indicator .icon-play {
    display: none;
  }

  .status-cell:hover .icon-pause {
    display: none;
  }

  .status-cell:hover .icon-play {
    display: flex;
  }

  .status-cell:hover .hibernation-indicator {
    opacity: 1;
  }

  .workspace-item.hibernated .workspace-btn {
    opacity: 0.55;
    font-style: italic;
  }
</style>
