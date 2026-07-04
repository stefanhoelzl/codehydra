<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import * as api from "$lib/api";
  import type { SidebarLabelScroll, UiNotification, UiProjectRow } from "@shared/ui-state";
  import type { UIMode } from "@shared/ipc";
  import AgentStatusIndicator from "./AgentStatusIndicator.svelte";
  import ScrollingLabel from "./ScrollingLabel.svelte";
  import Icon from "./Icon.svelte";
  import NotificationStack from "./NotificationStack.svelte";
  import {
    getWorkspaceGlobalIndex,
    formatIndexDisplay,
    getShortcutHint,
    getStatusText,
  } from "$lib/utils/sidebar-utils.js";
  import { createLogger } from "$lib/logging";
  import { clampSidebarWidthMin } from "@shared/ui-state";

  const logger = createLogger("ui");

  interface SidebarProps {
    /** Render-ready project rows from the UiState snapshot. */
    projects: readonly UiProjectRow[];
    /** Persisted expanded-sidebar width (px) from the snapshot. */
    sidebarWidth: number;
    /** Open sidebar notifications from the snapshot. */
    notifications: readonly UiNotification[];
    /** The single UI mode from the snapshot (main-owned). */
    mode?: UIMode;
    /** How overflowing row labels scroll (config `sidebar.label-scroll`). */
    labelScroll?: SidebarLabelScroll;
    shortcutModeActive?: boolean;
    /**
     * True while main is capturing the hibernation screenshot: force the
     * sidebar collapsed (overriding mode) so it is not baked into the shot.
     */
    capturing?: boolean;
    /** When true, the New workspace view is the current tab (highlight it instead of any workspace). */
    newWorkspaceViewOpen?: boolean;
    onCloseProject: (projectId: string) => void;
    /** Switch to a workspace by its opaque snapshot row key. */
    onSwitchWorkspace: (key: string) => void;
    onOpenNewWorkspace: () => void;
    /** Request the remove flow for a workspace by its snapshot row key. */
    onRemoveWorkspace: (key: string) => void;
  }

  let {
    projects,
    sidebarWidth,
    notifications,
    mode = "workspace",
    labelScroll = "hover",
    shortcutModeActive = false,
    capturing = false,
    newWorkspaceViewOpen = false,
    onCloseProject,
    onSwitchWorkspace,
    onOpenNewWorkspace,
    onRemoveWorkspace,
  }: SidebarProps = $props();

  const totalWorkspaces = $derived(
    projects.reduce((sum, project) => sum + project.workspaces.length, 0)
  );

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

  // The workspace row currently under the cursor (its snapshot key), so the
  // `hover` label-scroll mode can animate only that row's overflowing lines.
  let hoveredRowKey = $state<string | null>(null);

  // Sidebar is expanded when:
  // - the snapshot mode is anything but "workspace" (hover, shortcut, dialog —
  //   the creation panel maps to hover), OR
  // - there are no workspaces (so user can open a project)
  // ...unless main is capturing the hibernation screenshot, which forces the
  // sidebar collapsed so it is not baked into the shot.
  const isExpanded = $derived(!capturing && (mode !== "workspace" || totalWorkspaces === 0));

  // Hover may only initiate expansion when nothing else forces the UI on top
  // (i.e. the snapshot mode is "workspace"); otherwise the sidebar expanding
  // into a parked cursor would latch hover and keep it open after that mode
  // exits.
  const hoverExpansionEligible = $derived(mode === "workspace");

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
    if (!hoverExpansionEligible) {
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
        if (!hoverExpansionEligible) return;
        logger.debug("sidebar hover: expand");
        isHovering = true;
        // Main consumes the settled hover and folds it into the snapshot mode
        // (which drives isExpanded). No local expansion state.
        api.emitEvent({ kind: "hover", region: "sidebar" });
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
    // Mid-resize the drag overlay sits on top and the nav emits a spurious
    // mouseleave as the pointer "enters" it; never collapse while dragging.
    if (dragging) return;
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
      api.emitEvent({ kind: "hover", region: null });
    }, HOVER_DELAY_MS);
  }

  // Clean up timeouts on component destroy
  onDestroy(() => {
    clearOpenTimeout();
    clearCollapseTimeout();
  });

  // ============ Resize ============
  // The expanded sidebar's right edge is a drag handle. Dragging sets a local
  // `liveWidth` override applied to --ch-sidebar-width; on release we persist
  // it (resize-sidebar ui:event) and the presenter echoes the canonical value
  // back in the next snapshot. The override lingers until the snapshot's
  // `sidebarWidth` prop catches up, so there is no flash back to the old width.

  let dragging = $state(false);
  /** Live width while dragging / awaiting the snapshot echo; null = use prop. */
  let liveWidth = $state<number | null>(null);
  let dragStartX = 0;
  let dragStartWidth = 0;
  // Window inner width, tracked reactively so the max clamp follows resizes.
  let winWidth = $state(typeof window !== "undefined" ? window.innerWidth : 0);

  function clampWidth(width: number): number {
    // Both bounds run through the shared floor helper: the max is 75% of the
    // window width but never below the grow-only minimum (tiny windows), so the
    // result is always >= the floor.
    const floored = clampSidebarWidthMin(width);
    const max = clampSidebarWidthMin(winWidth * 0.75);
    return Math.min(floored, max);
  }

  const effectiveWidth = $derived(clampWidth(liveWidth ?? sidebarWidth));

  // Drop the local override once the snapshot's width prop changes — i.e. it
  // has caught up to (or overridden) the drag result — so there is no flash
  // back to the old width while the resize round-trips. `dragging` is read via
  // untrack so this fires only on a genuine prop change, never when a drag ends
  // (which would otherwise clear the override before the echo arrives). While a
  // drag is in flight the override wins.
  $effect(() => {
    void sidebarWidth;
    if (!untrack(() => dragging)) liveWidth = null;
  });

  function handleResizeStart(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    dragging = true;
    dragStartX = event.clientX;
    dragStartWidth = effectiveWidth;
    liveWidth = dragStartWidth;
    // Cancel any pending hover arm/collapse so the drawer stays put mid-drag.
    clearOpenTimeout();
    clearCollapseTimeout();
    logger.debug("sidebar resize: start", { startX: dragStartX, startWidth: dragStartWidth });
  }

  function handleResizeMove(event: MouseEvent): void {
    if (!dragging) return;
    liveWidth = clampWidth(dragStartWidth + (event.clientX - dragStartX));
  }

  function handleResizeEnd(event: MouseEvent): void {
    if (!dragging) return;
    const finalWidth = clampWidth(dragStartWidth + (event.clientX - dragStartX));
    dragging = false;
    liveWidth = finalWidth;
    logger.debug("sidebar resize: end", { finalWidth });
    api.emitEvent({ kind: "resize-sidebar", width: finalWidth });
    // If the cursor came to rest past the sidebar's new right edge — over the
    // workspace, not the drawer — release the hover so it can collapse. The
    // mouseleave suppressed during the drag would otherwise latch it open.
    if (event.clientX > finalWidth) {
      isHovering = false;
      api.emitEvent({ kind: "hover", region: null });
    }
  }

  function handleWindowResize(): void {
    winWidth = window.innerWidth;
  }

  // ============ Actions ============

  function handleWakeWorkspace(key: string): void {
    api.emitEvent({ kind: "wake-workspace", key });
  }
</script>

<!--
  Two-column row layout: every row is [flexible label cell | fixed icon cell
  at the right edge]. Collapsing the sidebar shrinks the label cells to zero
  width, so the icon column IS the collapsed sidebar.
-->
<svelte:window onresize={handleWindowResize} />

<nav
  class="sidebar"
  class:expanded={isExpanded || dragging}
  class:ch-sidebar-expanded={isExpanded || dragging}
  class:dragging
  style="--ch-sidebar-width: {effectiveWidth}px"
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
      {#each projects as project, projectIndex (project.id)}
        {#if projectIndex > 0}
          <vscode-divider></vscode-divider>
        {/if}
        <li class="project-item">
          <div class="project-header ch-label-cell">
            <span class="project-icon" title={project.title}>
              <Icon name={project.remote ? "source-control" : "folder-opened"} size={14} />
            </span>
            <span class="project-name" title={project.title}>{project.name}</span>
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
            {#each project.workspaces as workspace, workspaceIndex (workspace.key)}
              {@const globalIndex = getWorkspaceGlobalIndex(projects, projectIndex, workspaceIndex)}
              {@const displayIndex = formatIndexDisplay(globalIndex)}
              {@const shortcutHint = getShortcutHint(globalIndex)}
              {@const agentCounts =
                "counts" in workspace.agent ? workspace.agent.counts : { idle: 0, busy: 0 }}
              {@const statusText = getStatusText(agentCounts.idle, agentCounts.busy)}
              {@const isActive = workspace.active}
              {@const status = workspace.status}
              {@const hasTags = workspace.tags.length > 0}
              {@const hibernated = workspace.hibernated}
              {@const hasTitle = workspace.title !== undefined}
              {@const primaryLabel = workspace.title ?? workspace.name}
              <!-- Second line: the branch (only when a title took line 1) plus
                   any tags, scrolling as one unit. -->
              {@const showSecondLine = hasTitle || hasTags}
              {@const rowHovered = hoveredRowKey === workspace.key}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
              <li
                class="workspace-item"
                class:active={isActive}
                class:has-second-line={showSecondLine}
                class:hibernated
                aria-current={isActive ? "true" : undefined}
                onclick={() => {
                  if (status !== "creating") onSwitchWorkspace(workspace.key);
                }}
                onmouseenter={() => (hoveredRowKey = workspace.key)}
                onmouseleave={() => {
                  if (hoveredRowKey === workspace.key) hoveredRowKey = null;
                }}
              >
                <div class="workspace-row">
                  <div class="ch-label-cell workspace-label-cell">
                    <button
                      type="button"
                      class="workspace-btn"
                      aria-label={workspace.name + (shortcutModeActive ? shortcutHint : "")}
                    >
                      <span class="ws-line ws-primary-line">
                        {#if shortcutModeActive && !hibernated}
                          <vscode-badge
                            class="shortcut-badge"
                            class:badge-dimmed={displayIndex === null}
                            aria-hidden="true"
                          >
                            {displayIndex ?? "·"}
                          </vscode-badge>
                        {/if}
                        <ScrollingLabel mode={labelScroll} hovered={rowHovered}>
                          <span class="ws-primary-text">{primaryLabel}</span>
                        </ScrollingLabel>
                      </span>
                      {#if showSecondLine}
                        <span class="ws-line ws-secondary-line">
                          <ScrollingLabel mode={labelScroll} hovered={rowHovered}>
                            {#if hasTitle}
                              <span class="ws-branch">{workspace.name}</span>
                            {/if}
                            {#each workspace.tags as tag (tag.name)}
                              <span class="ws-tag" style:--tag-color={tag.color ?? null}
                                >{tag.name}</span
                              >
                            {/each}
                          </ScrollingLabel>
                        </span>
                      {/if}
                    </button>
                    {#if status === "ready"}
                      <button
                        type="button"
                        class="action-btn remove-btn"
                        id={`remove-ws-${workspace.key}`}
                        aria-label="Remove workspace"
                        onclick={(e) => {
                          e.stopPropagation();
                          onRemoveWorkspace(workspace.key);
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
                    aria-label={`${workspace.name} in ${project.name} - ${status === "creating" ? "Creating" : status === "deleting" ? "Deleting" : status === "delete-failed" ? "Deletion failed" : hibernated ? "Hibernated - click to wake" : statusText}`}
                    aria-current={isActive ? "true" : undefined}
                    onclick={() => {
                      if (hibernated) handleWakeWorkspace(workspace.key);
                    }}
                  >
                    {#if status === "creating"}
                      <!-- Creating: show red "busy" immediately (work is queued) -->
                      <AgentStatusIndicator idleCount={0} busyCount={1} />
                    {:else if status === "deleting"}
                      <vscode-progress-ring class="deletion-spinner"></vscode-progress-ring>
                    {:else if status === "delete-failed"}
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
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  </div>

  <NotificationStack {notifications} {isExpanded} />

  <!-- Drag handle on the expanded sidebar's right edge. Mouse-only (no keyboard
       resize by design), so it is hidden from assistive tech. -->
  {#if isExpanded || dragging}
    <div
      class="resize-handle"
      class:dragging
      aria-hidden="true"
      title="Drag to resize"
      onmousedown={handleResizeStart}
    ></div>
  {/if}
</nav>

<!-- Full-window capture layer active only while dragging: it sits above the
     workspace iframes (which would otherwise swallow mousemove) so the drag
     tracks smoothly, and ends the drag on release or when the pointer leaves. -->
{#if dragging}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="resize-overlay"
    onmousemove={handleResizeMove}
    onmouseup={handleResizeEnd}
    onmouseleave={handleResizeEnd}
  ></div>
{/if}

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

  /* While dragging the width follows the cursor every frame; the transition
     would only add lag. */
  .sidebar.dragging {
    transition: none;
  }

  /* ============ Resize handle ============ */

  .resize-handle {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 6px;
    cursor: ew-resize;
    z-index: 1;
    /* A thin accent line, revealed on hover / while dragging. */
    background: transparent;
    transition: background-color 120ms ease-out;
  }

  .resize-handle:hover,
  .resize-handle.dragging {
    background: var(--ch-focus-border);
  }

  /* Full-window pointer capture during a drag: transparent, above every UI
     layer and the workspace iframes, keeping the ew-resize cursor throughout. */
  .resize-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    cursor: ew-resize;
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

  /* Collapsed, the gutter is only ~20px wide, so the native scrollbar would
     sit on top of the status-indicator icon column and hide it. Hide the
     scrollbar in collapsed mode (wheel scrolling still works); the real
     scrollbar returns when the sidebar expands and has room for it. */
  .sidebar:not(.expanded) .sidebar-content {
    scrollbar-width: none;
  }

  .sidebar:not(.expanded) .sidebar-content::-webkit-scrollbar {
    display: none;
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

  .sidebar.expanded .workspace-item.has-second-line {
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
    border-radius: var(--ch-radius-sm, 6px);
    /* Stack the primary label over the branch/tags line. */
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: hidden;
  }

  .ws-line {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .ws-primary-line {
    gap: 4px;
  }

  /* The scrolling label fills the line and clips; the shortcut badge (if any)
     keeps its intrinsic width beside it. */
  .ws-line :global(.scroll) {
    flex: 1 1 0;
  }

  .ws-secondary-line {
    font-size: 11px;
  }

  .ws-branch {
    color: var(--ch-foreground);
    opacity: 0.6;
  }

  /* Inline tag pill on the row's second line (branch + tags scroll together). */
  .ws-tag {
    --_color: var(--tag-color, var(--ch-foreground));
    display: inline-block;
    font-size: 10px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 8px;
    border: 1px solid var(--_color);
    background: color-mix(in srgb, var(--_color) 50%, transparent);
    color: var(--ch-foreground);
    white-space: nowrap;
    font-weight: 500;
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
