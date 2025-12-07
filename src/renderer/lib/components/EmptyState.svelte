<script lang="ts">
  interface EmptyStateProps {
    onOpenProject: () => void;
    shortcutModeActive?: boolean;
  }

  let { onOpenProject, shortcutModeActive = false }: EmptyStateProps = $props();
</script>

<div class="empty-state">
  <p class="empty-message">No projects open.</p>
  <button
    class="open-project-btn"
    type="button"
    aria-label={"Open Project" + (shortcutModeActive ? " - Press O" : "")}
    onclick={onOpenProject}
  >
    {#if shortcutModeActive}
      <span class="shortcut-index" aria-hidden="true">O</span>
    {/if}
    Open Project
  </button>
</div>

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 20px;
    gap: 12px;
  }

  .empty-message {
    color: var(--ch-foreground);
    opacity: 0.7;
    margin: 0;
  }

  .open-project-btn {
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

  .open-project-btn:focus-visible {
    outline: 2px solid var(--ch-focus-border);
    outline-offset: 2px;
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
    border: 1px solid var(--ch-foreground);
    opacity: 0.8;
  }
</style>
