<script lang="ts">
  interface Props {
    active: boolean;
    workspaceCount?: number;
    hasActiveProject?: boolean;
    hasActiveWorkspace?: boolean;
  }

  let {
    active,
    workspaceCount = 0,
    hasActiveProject = false,
    hasActiveWorkspace = false,
  }: Props = $props();

  const showNavigation = $derived(workspaceCount > 1);
  const showJump = $derived(workspaceCount > 1);
  const showNew = $derived(hasActiveProject);
  const showDelete = $derived(hasActiveWorkspace);
</script>

<!-- 
  Content is always rendered (no {#if}) so fade-out transition works smoothly.
  aria-hidden prevents screen readers from reading invisible content.
  Dynamic sr-only text announces state changes for aria-live region.
  Use visibility:hidden (not display:none) for unavailable hints to prevent layout shifts.
-->
<div class="shortcut-overlay" class:active role="status" aria-live="polite" aria-hidden={!active}>
  {#if active}
    <span class="sr-only">Shortcut mode active.</span>
  {/if}
  <span
    class="shortcut-hint"
    class:shortcut-hint--hidden={!showNavigation}
    aria-label="Up and Down arrows to navigate"
  >
    ↑↓ Navigate
  </span>
  <span
    class="shortcut-hint"
    class:shortcut-hint--hidden={!showNew}
    aria-label="Enter key to create new workspace"
  >
    ⏎ New
  </span>
  <span
    class="shortcut-hint"
    class:shortcut-hint--hidden={!showDelete}
    aria-label="Delete key to remove workspace"
  >
    ⌫ Del
  </span>
  <span
    class="shortcut-hint"
    class:shortcut-hint--hidden={!showJump}
    aria-label="Number keys 1 through 0 to jump"
  >
    1-0 Jump
  </span>
  <span class="shortcut-hint" aria-label="O to open project"> O Open </span>
</div>

<style>
  .shortcut-overlay {
    position: fixed;
    bottom: 1rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    background: var(--vscode-editor-background, rgba(30, 30, 30, 0.9));
    border: 1px solid var(--vscode-panel-border, #454545);
    border-radius: 4px;
    padding: 0.5rem 1rem;
    display: flex;
    gap: 1rem;
    font-size: 0.875rem;
    color: var(--vscode-foreground, #cccccc);
    opacity: 0;
    pointer-events: none;
    transition: opacity 150ms ease-in-out;
  }

  .shortcut-overlay.active {
    opacity: 1;
  }

  .shortcut-hint {
    transition: opacity 150ms ease-out;
  }

  .shortcut-hint--hidden {
    visibility: hidden;
    opacity: 0;
  }

  /* Screen reader only - announces state changes */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
