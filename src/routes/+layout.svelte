<script lang="ts">
  import '@vscode-elements/elements/dist/bundled.js';
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import SetupModal from '$lib/components/SetupModal.svelte';
  import KeyboardShortcutOverlay from '$lib/components/KeyboardShortcutOverlay.svelte';
  import { checkRuntimeReady } from '$lib/api/tauri';
  import { restorePersistedProjects, closeProject } from '$lib/services/projectManager';
  import { initAgentStatusListener, loadInitialStatuses } from '$lib/stores/agentStatus';
  import { activeWorkspace, projects } from '$lib/stores/projects';
  import {
    codehydraShortcutActive,
    modalOpen,
    createDialogRequest,
    removeDialogRequest,
    navigateUp,
    navigateDown,
    jumpToIndex,
    isActiveWorkspaceMain,
  } from '$lib/stores/keyboardNavigation';
  import type { Snippet } from 'svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();

  // Whether we're still checking if runtime is ready
  let isChecking = $state(true);

  // Whether the runtime needs setup
  let needsSetup = $state(false);

  // Agent status listener cleanup function
  let unlistenAgentStatus: (() => void) | null = null;

  // Shortcut event listener cleanup functions
  let unlistenFunctions: UnlistenFn[] = [];

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

    // Load initial agent statuses AFTER projects are restored
    await loadInitialStatuses();

    // Start listening for agent status updates
    unlistenAgentStatus = await initAgentStatusListener();

    // Listen for Alt+X activation from Tauri
    unlistenFunctions.push(
      await listen('codehydra-shortcut-activated', () => {
        if (!get(modalOpen)) {
          codehydraShortcutActive.set(true);
        }
      })
    );

    // Listen for Alt+X release (deactivation) from Tauri
    unlistenFunctions.push(
      await listen('codehydra-shortcut-deactivated', () => {
        deactivateShortcutMode();
      })
    );

    // Listen for navigation actions
    unlistenFunctions.push(
      await listen('codehydra-action-up', () => {
        if (get(codehydraShortcutActive) && !get(modalOpen)) {
          navigateUp();
        }
      })
    );
    unlistenFunctions.push(
      await listen('codehydra-action-down', () => {
        if (get(codehydraShortcutActive) && !get(modalOpen)) {
          navigateDown();
        }
      })
    );

    // Listen for workspace actions
    unlistenFunctions.push(
      await listen('codehydra-action-create', () => {
        if (get(codehydraShortcutActive) && !get(modalOpen)) {
          const active = get(activeWorkspace);
          if (active) {
            createDialogRequest.set(active.projectHandle);
          }
        }
      })
    );
    unlistenFunctions.push(
      await listen('codehydra-action-remove', () => {
        if (get(codehydraShortcutActive) && !get(modalOpen)) {
          const active = get(activeWorkspace);
          if (active) {
            if (isActiveWorkspaceMain()) {
              // Close project for main workspace (same as x-button)
              const allProjects = get(projects);
              const project = allProjects.find((p) => p.handle === active.projectHandle);
              if (project) {
                closeProject(project);
              }
            } else {
              // Open remove dialog for additional workspaces
              removeDialogRequest.set(active);
            }
          }
        }
      })
    );

    // Listen for jump actions (1-9)
    for (let i = 1; i <= 9; i++) {
      const index = i;
      unlistenFunctions.push(
        await listen(`codehydra-action-jump-${i}`, () => {
          if (get(codehydraShortcutActive) && !get(modalOpen)) {
            jumpToIndex(index);
          }
        })
      );
    }
    // Jump to 10th (Alt+0)
    unlistenFunctions.push(
      await listen('codehydra-action-jump-0', () => {
        if (get(codehydraShortcutActive) && !get(modalOpen)) {
          jumpToIndex(10);
        }
      })
    );

    // Register window event listeners
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('keydown', onKeyDown);

    // Show window after frontend is ready (avoids white flash)
    invoke('show_window');
  });

  onDestroy(() => {
    // Clean up the agent status event listener to prevent memory leaks
    if (unlistenAgentStatus) {
      unlistenAgentStatus();
      unlistenAgentStatus = null;
    }

    // Clean up all shortcut listeners
    for (const unlisten of unlistenFunctions) {
      unlisten();
    }
    unlistenFunctions = [];

    // Clean up window listeners
    window.removeEventListener('blur', onWindowBlur);
    window.removeEventListener('keydown', onKeyDown);
  });

  function handleSetupComplete() {
    needsSetup = false;
  }

  /**
   * Deactivate shortcut mode and restore focus to the active iframe.
   * This ensures keyboard input works correctly in VS Code after shortcuts.
   */
  function deactivateShortcutMode() {
    if (!get(codehydraShortcutActive)) return;

    codehydraShortcutActive.set(false);

    // Restore focus to the active iframe after a brief delay
    // This ensures the keyboard state is properly restored in VS Code
    requestAnimationFrame(() => {
      const activeIframe = document.querySelector(
        '.workspace-view.active iframe'
      ) as HTMLIFrameElement | null;
      if (activeIframe) {
        activeIframe.focus();
      }
    });
  }

  // Deactivate on window blur
  function onWindowBlur() {
    deactivateShortcutMode();
  }

  // Deactivate on Escape
  function onKeyDown(event: KeyboardEvent) {
    if (get(codehydraShortcutActive) && event.key === 'Escape') {
      deactivateShortcutMode();
    }
  }
</script>

<!-- Keyboard shortcut overlay (UI hints) -->
<KeyboardShortcutOverlay />

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
