<script lang="ts">
  import { projects, activeWorkspace } from '$lib/stores/projects';
  import { chimeShortcutActive } from '$lib/stores/keyboardNavigation';
  import { ensureCodeServerRunning, getWorkspaceUrl } from '$lib/api/tauri';
  import { tick } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { get } from 'svelte/store';

  // Store iframe references by workspace path
  const iframeElements = new SvelteMap<string, HTMLIFrameElement>();

  // Track workspace URLs (may need to be fetched dynamically)
  let workspaceUrls = $state<Map<string, string>>(new Map());

  // Track loading states for workspaces
  let loadingWorkspaces = $state<Set<string>>(new Set());

  // Track errors for workspaces
  let workspaceErrors = $state<Map<string, string>>(new Map());

  // Ensure code-server is running and get URL when a workspace becomes active
  $effect(() => {
    const active = $activeWorkspace;
    if (active) {
      // Find the workspace to check if it already has a URL from the backend
      const project = $projects.find((p) => p.handle === active.projectHandle);
      const workspace = project?.workspaces.find((w) => w.path === active.workspacePath);

      // Only call ensureWorkspaceReady if the workspace doesn't already have a URL
      // New workspaces created via createWorkspace already come with a URL from the backend
      if (!workspace?.url && !workspaceUrls.has(active.workspacePath)) {
        ensureWorkspaceReady(active.workspacePath);
      }
    }
  });

  // Focus the active iframe whenever it changes
  $effect(() => {
    const active = $activeWorkspace;
    if (active) {
      focusActiveIframe(active.workspacePath);
    }
  });

  async function ensureWorkspaceReady(workspacePath: string): Promise<void> {
    // Skip if we already have a URL or are already loading
    if (workspaceUrls.has(workspacePath) || loadingWorkspaces.has(workspacePath)) {
      return;
    }

    // Mark as loading
    loadingWorkspaces = new Set([...loadingWorkspaces, workspacePath]);
    workspaceErrors = new Map([...workspaceErrors].filter(([k]) => k !== workspacePath));

    try {
      // Ensure code-server is running first
      await ensureCodeServerRunning();

      // Get the URL for this workspace
      const url = await getWorkspaceUrl(workspacePath);

      if (url) {
        workspaceUrls = new Map([...workspaceUrls, [workspacePath, url]]);
      } else {
        workspaceErrors = new Map([
          ...workspaceErrors,
          [workspacePath, 'Failed to get workspace URL'],
        ]);
      }
    } catch (error) {
      console.error('Failed to start code-server for workspace:', workspacePath, error);
      workspaceErrors = new Map([
        ...workspaceErrors,
        [workspacePath, error instanceof Error ? error.message : String(error)],
      ]);
    } finally {
      loadingWorkspaces = new Set([...loadingWorkspaces].filter((p) => p !== workspacePath));
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
        {@const isLoading = loadingWorkspaces.has(workspace.path)}
        {@const error = workspaceErrors.get(workspace.path)}
        {@const url = getWorkspaceUrlForPath(workspace.path, workspace.url)}

        {#if isActive && isLoading}
          <div class="loading-state">
            <vscode-icon name="loading" size="48"></vscode-icon>
            <p>Starting code-server...</p>
          </div>
        {:else if isActive && error}
          <div class="error-state">
            <vscode-icon name="error" size="48"></vscode-icon>
            <p>Failed to start code-server</p>
            <p class="error-message">{error}</p>
          </div>
        {:else if url}
          <iframe
            use:handleIframeElement={workspace.path}
            src={url}
            title="{workspace.name} - {workspace.branch || 'detached'}"
            class="workspace-iframe"
            class:hidden={!isActive}
          ></iframe>
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

  .workspace-iframe {
    width: 100%;
    height: 100%;
    border: none;
    position: absolute;
    top: 0;
    left: 0;
    /* Use visibility instead of display to preserve iframe state */
    visibility: visible;
  }

  .workspace-iframe.hidden {
    /* Keep iframe alive but hidden - preserves VSCode state (tabs, terminals, etc.) */
    visibility: hidden;
    /* Move off-screen to prevent any potential rendering issues */
    pointer-events: none;
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
