<script lang="ts">
  // EmptyState is a simple message component shown when no projects are open.
  // The "Open Project" button is rendered separately in Sidebar's footer
  // to ensure consistent positioning regardless of project state.
</script>

<div class="empty-state">
  <p class="empty-message">No projects open.</p>
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
