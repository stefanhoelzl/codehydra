<script lang="ts">
  interface Props {
    active: boolean;
    workspaceCount?: number;
    hasActiveProject?: boolean;
    hasActiveWorkspace?: boolean;
    activeWorkspaceDeletionInProgress?: boolean;
    idleWorkspaceCount?: number;
  }

  let {
    active,
    workspaceCount = 0,
    hasActiveProject = false,
    hasActiveWorkspace = false,
    activeWorkspaceDeletionInProgress = false,
    idleWorkspaceCount = 0,
  }: Props = $props();

  const showNavigation = $derived(workspaceCount > 1);
  const showJump = $derived(workspaceCount > 1);
  const showNew = $derived(hasActiveProject);
  const showDelete = $derived(hasActiveWorkspace && !activeWorkspaceDeletionInProgress);
  const showIdleNavigation = $derived(idleWorkspaceCount >= 2);
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
  <span class="shortcut-hint" aria-label="O to open project">
    <vscode-badge>O</vscode-badge> Open
  </span>
</div>

<style>
  .shortcut-overlay {
    position: fixed;
    bottom: 1rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    background: var(--ch-background);
    border: 1px solid var(--ch-border);
    border-radius: 4px;
    padding: 0.5rem 1rem;
    display: flex;
    gap: 1rem;
    font-size: 0.875rem;
    color: var(--ch-foreground);
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
