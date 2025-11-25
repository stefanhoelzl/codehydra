<script lang="ts">
  import { projects, activeWorkspace } from '$lib/stores/projects';
  import { chimeShortcutActive } from '$lib/stores/keyboardNavigation';
  import { agentCounts } from '$lib/stores/agentStatus';
  import { ensureCodeServerRunning, getWorkspaceUrl } from '$lib/api/tauri';
  import { tick, onDestroy } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { get } from 'svelte/store';
  import { fade } from 'svelte/transition';
  import { WorkspaceInitService } from '$lib/services/workspaceInit';

  // Store iframe references by workspace path
  const iframeElements = new SvelteMap<string, HTMLIFrameElement>();

  // Track workspace URLs (may need to be fetched dynamically)
  const workspaceUrls = new SvelteMap<string, string>();

  // Workspace initialization service (manages state, errors, and timeouts)
  const initService = new WorkspaceInitService();

  // Ensure code-server is running and get URL when a workspace becomes active
  $effect(() => {
    const active = $activeWorkspace;
    if (active) {
      // Find the workspace to check if it already has a URL from the backend
      const project = $projects.find((p) => p.handle === active.projectHandle);
      const workspace = project?.workspaces.find((w) => w.path === active.workspacePath);

      // Start initialization for the workspace
      // If workspace already has a URL from backend, skip loading phase
      if (workspace?.url) {
        startInitializationWithUrl(active.workspacePath, workspace.url);
      } else if (!workspaceUrls.has(active.workspacePath)) {
        // No URL yet - need to fetch it
        ensureWorkspaceReady(active.workspacePath);
      }
    }
  });

  // Watch agent counts to transition from 'initializing' to 'ready' when agents detected
  $effect(() => {
    const counts = $agentCounts;
    initService.checkAndUpdateFromAgentCounts(counts);
  });

  // Focus the active iframe whenever it changes
  $effect(() => {
    const active = $activeWorkspace;
    if (active) {
      focusActiveIframe(active.workspacePath);
    }
  });

  // Cleanup timeouts on component destroy
  onDestroy(() => {
    initService.cleanupAllTimeouts();
  });

  /**
   * Start initialization for a workspace that already has a URL.
   * Skips the loading phase and goes directly to initializing.
   */
  function startInitializationWithUrl(workspacePath: string, url: string): void {
    // Skip if already in a state (already initialized or initializing)
    if (initService.workspaceState.has(workspacePath)) {
      return;
    }

    // Store the URL
    workspaceUrls.set(workspacePath, url);

    // Start initialization (checks for agents, sets up timeout)
    const currentCounts = get(agentCounts).get(workspacePath);
    initService.startInitialization(workspacePath, currentCounts);
  }

  /**
   * Fetch URL and start initialization for a workspace without a URL.
   */
  async function ensureWorkspaceReady(workspacePath: string): Promise<void> {
    // Skip if we already have a URL or are already in a state
    if (workspaceUrls.has(workspacePath) || initService.workspaceState.has(workspacePath)) {
      return;
    }

    // Set to loading state
    initService.setLoading(workspacePath);

    try {
      // Ensure code-server is running first
      await ensureCodeServerRunning();

      // Get the URL for this workspace
      const url = await getWorkspaceUrl(workspacePath);

      if (url) {
        workspaceUrls.set(workspacePath, url);

        // Start initialization (checks for agents, sets up timeout)
        const currentCounts = get(agentCounts).get(workspacePath);
        initService.startInitialization(workspacePath, currentCounts);
      } else {
        initService.setError(workspacePath, 'Failed to get workspace URL');
      }
    } catch (error) {
      console.error('Failed to start code-server for workspace:', workspacePath, error);
      initService.setError(workspacePath, error instanceof Error ? error.message : String(error));
    }
  }

  async function focusActiveIframe(workspacePath: string) {
    await tick();
    // Don't focus iframe if keyboard shortcut mode is active
    // The layout will handle focusing the iframe when shortcut mode deactivates
    if (get(chimeShortcutActive)) {
      return;
    }
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

  function getWorkspaceUrlForPath(workspacePath: string, fallbackUrl: string): string | null {
    // Prefer dynamically fetched URL, fall back to workspace.url from discovery
    return workspaceUrls.get(workspacePath) ?? fallbackUrl ?? null;
  }

  /**
   * Cleanup workspace state when it's removed.
   * This should be called when a workspace is deleted.
   */
  export function cleanupWorkspace(workspacePath: string): void {
    initService.cleanupWorkspace(workspacePath);
    workspaceUrls.delete(workspacePath);
    iframeElements.delete(workspacePath);
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
        {@const isActive = $activeWorkspace?.workspacePath === workspace.path}
        {@const state = initService.workspaceState.get(workspace.path)}
        {@const error = initService.workspaceErrors.get(workspace.path)}
        {@const url = getWorkspaceUrlForPath(workspace.path, workspace.url)}

        {#if isActive && state === 'loading'}
          <div class="loading-state" aria-live="polite">
            <span class="spinner-large" role="progressbar" aria-label="Loading"></span>
            <p>Starting code-server...</p>
          </div>
        {:else if isActive && state === 'error'}
          <div class="error-state" aria-live="assertive">
            <vscode-icon name="error" size="48"></vscode-icon>
            <p>Failed to start code-server</p>
            <p class="error-message">{error}</p>
          </div>
        {:else if url}
          <!-- Container for iframe and overlay -->
          <div class="iframe-container" class:hidden={!isActive}>
            <iframe
              use:handleIframeElement={workspace.path}
              src={url}
              title="{workspace.name} - {workspace.branch || 'detached'}"
              class="workspace-iframe"
            ></iframe>
            <!-- Initializing overlay - covers iframe while VSCode loads -->
            {#if isActive && state === 'initializing'}
              <div
                class="initializing-overlay"
                transition:fade={{ duration: 150 }}
                aria-live="polite"
              >
                <span class="spinner-large" role="progressbar" aria-label="Initializing"></span>
                <p>Initializing workspace...</p>
              </div>
            {/if}
          </div>
        {/if}
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
    overflow: hidden;
  }

  .iframe-container {
    width: 100%;
    height: 100%;
    position: absolute;
    top: 0;
    left: 0;
  }

  .iframe-container.hidden {
    /* Keep iframe alive but hidden - preserves VSCode state (tabs, terminals, etc.) */
    visibility: hidden;
    /* Move off-screen to prevent any potential rendering issues */
    pointer-events: none;
  }

  .workspace-iframe {
    width: 100%;
    height: 100%;
    border: none;
  }

  .initializing-overlay {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    color: var(--vscode-descriptionForeground, #ababab);
    background: var(--vscode-editor-background, #1e1e1e);
  }

  .initializing-overlay p {
    margin: 0;
    font-size: 14px;
  }

  /* Large spinner for loading states */
  .spinner-large {
    display: inline-block;
    width: 48px;
    height: 48px;
    border: 3px solid transparent;
    border-top-color: var(--vscode-progressBar-background, #0e70c0);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .empty-state,
  .loading-state,
  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 16px;
    color: var(--vscode-descriptionForeground, #ababab);
  }

  .empty-state p,
  .loading-state p,
  .error-state p {
    margin: 0;
    font-size: 14px;
  }

  .error-state {
    color: var(--vscode-errorForeground, #f48771);
  }

  .error-message {
    font-size: 12px;
    opacity: 0.8;
    max-width: 400px;
    text-align: center;
    word-break: break-word;
  }
</style>
