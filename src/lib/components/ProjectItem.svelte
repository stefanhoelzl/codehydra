<script lang="ts">
  import type { Project } from '$lib/types/project';
  import { setActiveProject } from '$lib/stores/projects';
  import { closeProject } from '$lib/services/projectManager';
  
  export let project: Project;
  export let active: boolean = false;
  
  function handleClick() {
    setActiveProject(project.id);
  }
  
  function handleClose(e: MouseEvent) {
    e.stopPropagation();
    closeProject(project);
  }
</script>

<div 
  class="project-item" 
  class:active 
  on:click={handleClick}
  on:keydown={(e) => e.key === 'Enter' && handleClick()}
  role="button"
  tabindex="0"
>
  <vscode-icon name="folder" class="icon"></vscode-icon>
  <span class="name">{project.name}</span>
  <vscode-icon 
    name="close" 
    class="close-btn"
    on:click={handleClose}
  ></vscode-icon>
</div>

<style>
  .project-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    cursor: pointer;
    color: var(--vscode-sideBar-foreground);
    user-select: none;
  }
  
  .project-item:hover {
    background: var(--vscode-list-hoverBackground);
  }
  
  .project-item.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  
  .icon {
    flex-shrink: 0;
  }
  
  .name {
    flex: 1;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .close-btn {
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.1s;
  }
  
  .project-item:hover .close-btn,
  .project-item.active .close-btn {
    opacity: 1;
  }
  
  .close-btn:hover {
    color: var(--vscode-errorForeground);
  }
</style>
