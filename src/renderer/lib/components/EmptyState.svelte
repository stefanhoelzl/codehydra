<script lang="ts">
  interface EmptyStateProps {
    onOpenProject: () => void;
  }

  let { onOpenProject }: EmptyStateProps = $props();
</script>

<div class="empty-state">
  <p class="empty-message">No projects open.</p>
  <button class="open-project-btn" type="button" onclick={onOpenProject}> Open Project </button>
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
</style>
