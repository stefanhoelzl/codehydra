<script lang="ts">
  import Sidebar from '$lib/components/Sidebar.svelte';
  import WorkspaceView from '$lib/components/WorkspaceView.svelte';
  import { onDestroy } from 'svelte';
  import { cleanupAllServers } from '$lib/api/tauri';

  // Cleanup on page unload
  onDestroy(() => {
    cleanupAllServers().catch(console.error);
  });
</script>

<main>
  <Sidebar />
  <WorkspaceView />
</main>

<style>
  main {
    display: flex;
    height: 100%;
    width: 100%;
    overflow: hidden;
    position: fixed;
    top: 0;
    left: 0;
    background: var(--vscode-editor-background, #1e1e1e);
  }
</style>
