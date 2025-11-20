<script lang="ts">
  import { projects, activeWorkspace } from '$lib/stores/projects';
  import { tick } from 'svelte';

  // Store iframe references by workspace path
  const iframeElements = new Map<string, HTMLIFrameElement>();

  // Focus the active iframe whenever it changes
  $: {
    if ($activeWorkspace) {
      focusActiveIframe($activeWorkspace.workspacePath);
    }
  }

  async function focusActiveIframe(workspacePath: string) {
    await tick();
    const iframe = iframeElements.get(workspacePath);
    if (iframe) {
      setTimeout(() => {
        iframe.focus();
      }, 100);
    }
  }

  function handleIframeElement(node: HTMLIFrameElement, workspacePath: string) {
    iframeElements.set(workspacePath, node);

    return {
      destroy() {
        iframeElements.delete(workspacePath);
      },
    };
  }
</script>

<div class="workspace-view">
  {#if $projects.length === 0}
    <div class="empty-state">
      <vscode-icon name="folder-opened" size="48"></vscode-icon>
      <p>Open a project to get started</p>
    </div>
  {:else}
    <!-- Show iframes for all workspaces -->
    {#each $projects as project (project.handle)}
      {#each project.workspaces as workspace (workspace.path)}
        <iframe
          use:handleIframeElement={workspace.path}
          src={workspace.url}
          title="{workspace.name} - {workspace.branch || 'detached'}"
          class="workspace-iframe"
          class:hidden={$activeWorkspace?.workspacePath !== workspace.path}
        ></iframe>
      {/each}
    {/each}
  {/if}
</div>

<style>
  .workspace-view {
    flex: 1;
    height: 100%;
    background: var(--vscode-editor-background, #1e1e1e);
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
    color: var(--vscode-descriptionForeground, #ababab);
  }

  .empty-state p {
    margin: 0;
    font-size: 14px;
  }
</style>
