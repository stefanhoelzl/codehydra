<script lang="ts">
  // EmptyState is a simple message component shown when no projects are open.
  // Users can open a project via the Create Workspace dialog's folder icon.
</script>

<div class="empty-state">
  <p class="empty-message">
    No projects open. Click the + button on a project header to create a workspace, or open a
    project via the Create Workspace dialog.
  </p>
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
