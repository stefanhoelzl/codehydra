<script lang="ts">
  import type { HibernatedView } from "@shared/ui-state";

  interface Props {
    active: boolean;
    workspaceCount?: number;
    hasActiveWorkspace?: boolean;
    activeHibernated?: boolean;
    activeWorkspaceDeletionInProgress?: boolean;
    idleWorkspaceCount?: number;
    /**
     * What T would change: the hibernated list of the active workspace's
     * project (or of every project while the sidebar's Find field is open);
     * null hides the hint (no active workspace).
     */
    hibernatedView?: HibernatedView | null;
    /**
     * What C would change: whether the active workspace's project is
     * collapsed; null hides the hint (no active workspace, or Find is open).
     */
    activeCollapsed?: boolean | null;
    /** Whether the sidebar shows each row's CPU and memory (drives the M hint label). */
    processSummary?: boolean;
    /** Whether the sidebar is docked (drives the P hint label). */
    sidebarDocked?: boolean;
  }

  let {
    active,
    workspaceCount = 0,
    hasActiveWorkspace = false,
    activeHibernated = false,
    activeWorkspaceDeletionInProgress = false,
    idleWorkspaceCount = 0,
    hibernatedView = null,
    activeCollapsed = null,
    sidebarDocked = false,
    processSummary = false,
  }: Props = $props();

  // When there's no active workspace (e.g. the New workspace view is the
  // current tab), any workspace is a valid navigation target — so the
  // thresholds drop by one (1 workspace is enough for ↑↓/1-0/←→ to do
  // something useful).
  const minToNavigate = $derived(hasActiveWorkspace ? 2 : 1);
  const showNavigation = $derived(workspaceCount >= minToNavigate);
  const showJump = $derived(workspaceCount >= minToNavigate);
  // Always show "New" hint - Enter opens Create Workspace dialog even without projects
  const showNew = true;
  const showDelete = $derived(hasActiveWorkspace && !activeWorkspaceDeletionInProgress);
  const showIdleNavigation = $derived(idleWorkspaceCount >= minToNavigate);
  // T cycles hidden → hibernated → hibernated and automated → hidden.
  const NEXT_HIBERNATED_LABEL: Record<HibernatedView, string> = {
    hidden: "Show hibernated",
    manual: "Show automated",
    all: "Hide hibernated",
  };
</script>

<!-- 
  Content is always rendered (no {#if}) so fade-out transition works smoothly.
  aria-hidden prevents screen readers from reading invisible content.
  Dynamic sr-only text announces state changes for aria-live region.
  Hidden hints use display:none for dynamic sizing (elements don't change while overlay is visible).
-->
<div class="shortcut-overlay" class:active role="status" aria-live="polite" aria-hidden={!active}>
  {#if active}
    <span class="ch-visually-hidden">Shortcut mode active.</span>
  {/if}
  <span
    class="shortcut-hint"
    class:shortcut-hint--hidden={!showNavigation}
    aria-label="Up and Down arrows to navigate"
  >
    <vscode-badge>↑↓</vscode-badge> Navigate
  </span>
  <span
    class="shortcut-hint"
    class:shortcut-hint--hidden={!showIdleNavigation}
    aria-label="Left and Right arrows to jump to idle"
  >
    <vscode-badge>←→</vscode-badge> Idle
  </span>
  <span
    class="shortcut-hint"
    class:shortcut-hint--hidden={!showJump}
    aria-label="Number keys 1 through 0 to jump"
  >
    <vscode-badge>1-0</vscode-badge> Jump
  </span>
  <span class="shortcut-hint" aria-label="F key to find a workspace">
    <vscode-badge>F</vscode-badge> Find
  </span>
  <span
    class="shortcut-hint"
    class:shortcut-hint--hidden={!showDelete}
    aria-label="Delete key to remove workspace"
  >
    <vscode-badge>⌫</vscode-badge> Del
  </span>
  <span
    class="shortcut-hint"
    class:shortcut-hint--hidden={!showNew}
    aria-label="Enter key to create new workspace"
  >
    <vscode-badge>⏎</vscode-badge> New
  </span>
  <span
    class="shortcut-hint"
    class:shortcut-hint--hidden={!hasActiveWorkspace}
    aria-label={activeHibernated
      ? "H key to wake the active workspace"
      : "H key to toggle hibernation on the active workspace"}
  >
    <vscode-badge>H</vscode-badge>
    {activeHibernated ? "Wake" : "Hibernate"}
  </span>
  <span
    class="shortcut-hint"
    class:shortcut-hint--hidden={hibernatedView === null}
    aria-label={hibernatedView === null
      ? undefined
      : `T key: ${NEXT_HIBERNATED_LABEL[hibernatedView].toLowerCase()} workspaces`}
  >
    <vscode-badge>T</vscode-badge>
    {hibernatedView === null ? "" : NEXT_HIBERNATED_LABEL[hibernatedView]}
  </span>
  <span
    class="shortcut-hint"
    class:shortcut-hint--hidden={activeCollapsed === null}
    aria-label={activeCollapsed === null
      ? undefined
      : `C key: ${activeCollapsed ? "expand" : "collapse"} the active project`}
  >
    <vscode-badge>C</vscode-badge>
    {activeCollapsed === null ? "" : activeCollapsed ? "Expand project" : "Collapse project"}
  </span>
  <span
    class="shortcut-hint"
    aria-label={sidebarDocked ? "D key to undock the sidebar" : "D key to dock the sidebar"}
  >
    <vscode-badge>D</vscode-badge>
    {sidebarDocked ? "Undock" : "Dock"}
  </span>
  <span
    class="shortcut-hint"
    aria-label={processSummary
      ? "P key to hide the process summary"
      : "P key to show the process summary"}
  >
    <vscode-badge>P</vscode-badge>
    {processSummary ? "Hide processes" : "Show processes"}
  </span>
  <span class="shortcut-hint" aria-label="S key to open settings">
    <vscode-badge>S</vscode-badge> Settings
  </span>
</div>

<style>
  .shortcut-overlay {
    position: fixed;
    bottom: 1rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    background: var(--ch-surface-2, var(--ch-background));
    border: 1px solid var(--ch-input-hover-border, rgba(255, 255, 255, 0.12));
    border-radius: var(--ch-radius-sm, 6px);
    padding: 0.5rem 1rem;
    display: flex;
    gap: 1rem;
    font-size: 0.875rem;
    color: var(--ch-foreground);
    box-shadow: var(--ch-shadow);
    backdrop-filter: blur(8px);
    opacity: 0;
    pointer-events: none;
    transition: opacity 150ms ease-in-out;
  }

  .shortcut-overlay.active {
    opacity: 1;
  }

  .shortcut-hint--hidden {
    display: none;
  }
</style>
