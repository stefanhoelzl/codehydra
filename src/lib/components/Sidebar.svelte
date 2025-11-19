<script lang="ts">
  import { projects, activeProjectId } from '$lib/stores/projects';
  import { openNewProject } from '$lib/services/projectManager';
  import ProjectItem from './ProjectItem.svelte';
</script>

<aside class="sidebar">
  <div class="header">
    <h2>Projects</h2>
  </div>

  <div class="projects-list">
    {#each $projects as project (project.id)}
      <ProjectItem {project} active={$activeProjectId === project.id} />
    {/each}
  </div>

  <vscode-button class="open-btn" on:click={openNewProject}> Open Project </vscode-button>
</aside>

<style>
  .sidebar {
    width: clamp(200px, 20vw, 400px);
    height: 100vh;
    background: var(--vscode-sideBar-background);
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--vscode-sideBar-border);
  }

  .header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--vscode-sideBar-border);
  }

  .header h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--vscode-sideBarTitle-foreground);
    text-transform: uppercase;
  }

  .projects-list {
    flex: 1;
    overflow-y: auto;
  }

  .open-btn {
    margin: 12px;
    width: calc(100% - 24px);
  }
</style>
