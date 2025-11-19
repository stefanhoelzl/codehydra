<script lang="ts">
  import { projects, activeProjectId } from '$lib/stores/projects';
</script>

<div class="workspace-view">
  {#if $projects.length === 0}
    <div class="empty-state">
      <vscode-icon name="folder-opened" size="48"></vscode-icon>
      <p>Open a project to get started</p>
    </div>
  {:else}
    {#each $projects as project (project.id)}
      <iframe
        src={project.url}
        title={project.name}
        class="workspace-iframe"
        class:hidden={$activeProjectId !== project.id}
      ></iframe>
    {/each}
  {/if}
</div>

<style>
  .workspace-view {
    flex: 1;
    height: 100vh;
    background: var(--vscode-editor-background);
    position: relative;
  }

  .workspace-iframe {
    width: 100%;
    height: 100%;
    border: none;
    position: absolute;
    top: 0;
    left: 0;
  }

  .workspace-iframe.hidden {
    display: none;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 16px;
    color: var(--vscode-descriptionForeground);
  }

  .empty-state p {
    margin: 0;
    font-size: 14px;
  }
</style>
