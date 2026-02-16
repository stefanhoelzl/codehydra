<script lang="ts">
  // EmptyState is a simple message component shown when no projects are open.
  // Users can open a project by pressing Alt+X Enter.
</script>

<div class="empty-state">
  <p class="empty-message">No projects open.</p>
  <p class="empty-message">Press <vscode-badge>Alt+X+Enter</vscode-badge> to open a project.</p>
</div>

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 20px;
  }

  .empty-message {
    color: var(--ch-foreground);
    opacity: 0.7;
    margin: 0;
  }
</style>
