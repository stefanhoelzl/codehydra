<script lang="ts">
  import '@vscode-elements/elements/dist/bundled.js';
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import SetupModal from '$lib/components/SetupModal.svelte';
  import { checkRuntimeReady } from '$lib/api/tauri';
  import { restorePersistedProjects } from '$lib/services/projectManager';
  import type { Snippet } from 'svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();

  // Whether we're still checking if runtime is ready
  let isChecking = $state(true);

  // Whether the runtime needs setup
  let needsSetup = $state(false);

  onMount(async () => {
    try {
      // Check if runtime is ready
      const ready = await checkRuntimeReady();
      needsSetup = !ready;
    } catch (err) {
      // If check fails, assume we need setup
      console.error('Failed to check runtime status:', err);
      needsSetup = true;
    } finally {
      isChecking = false;
    }

    // Load persisted projects ALWAYS (regardless of setup state)
    await restorePersistedProjects();

    // Show window after frontend is ready (avoids white flash)
    invoke('show_window');
  });

  function handleSetupComplete() {
    needsSetup = false;
  }
</script>

{#if isChecking}
  <!-- Loading state while checking runtime -->
  <div class="loading">
    <p>Loading...</p>
  </div>
{:else if needsSetup}
  <!-- Show setup modal if runtime needs initialization -->
  <SetupModal onComplete={handleSetupComplete} />
{:else}
  <!-- Normal app content -->
  {@render children()}
{/if}

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    overflow: hidden;
    width: 100%;
    height: 100%;
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #d4d4d4);
    font-family: var(
      --vscode-font-family,
      -apple-system,
      BlinkMacSystemFont,
      'Segoe UI',
      Roboto,
      sans-serif
    );
  }

  :global(#svelte) {
    width: 100%;
    height: 100%;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
  }

  .loading p {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 14px;
  }
</style>
