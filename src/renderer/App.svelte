<script lang="ts">
  import * as api from "$lib/api";
  import {
    projects,
    activeWorkspacePath,
    loadingState,
    loadingError,
    activeProject,
    getAllWorkspaces,
    setProjects,
    addProject,
    removeProject,
    setActiveWorkspace,
    setLoaded,
    setError,
    addWorkspace,
    removeWorkspace,
  } from "$lib/stores/projects.svelte.js";
  import { dialogState, openCreateDialog, openRemoveDialog } from "$lib/stores/dialogs.svelte.js";
  import {
    shortcutModeActive,
    handleShortcutEnable,
    handleShortcutDisable,
    handleKeyDown,
    handleKeyUp,
    handleWindowBlur,
  } from "$lib/stores/shortcuts.svelte.js";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import CreateWorkspaceDialog from "$lib/components/CreateWorkspaceDialog.svelte";
  import RemoveWorkspaceDialog from "$lib/components/RemoveWorkspaceDialog.svelte";
  import ShortcutOverlay from "$lib/components/ShortcutOverlay.svelte";
  import type { ProjectPath } from "$lib/api";

  // Sync dialog state with main process z-order
  $effect(() => {
    const isDialogOpen = dialogState.value.type !== "closed";
    void api.setDialogMode(isDialogOpen);
  });

  // Subscribe to shortcut events from main process
  $effect(() => {
    const unsubEnable = api.onShortcutEnable(handleShortcutEnable);
    const unsubDisable = api.onShortcutDisable(handleShortcutDisable);
    return () => {
      unsubEnable();
      unsubDisable();
    };
  });

  // Set up initialization and event subscriptions on mount
  $effect(() => {
    // Track all subscriptions for cleanup
    const subscriptions: (() => void)[] = [];

    // Initialize - load projects
    api
      .listProjects()
      .then((p) => {
        setProjects(p);
        setLoaded();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load projects");
      });

    // Subscribe to events
    subscriptions.push(
      api.onProjectOpened((event) => {
        addProject(event.project);
      })
    );

    subscriptions.push(
      api.onProjectClosed((event) => {
        removeProject(event.path);
      })
    );

    subscriptions.push(
      api.onWorkspaceCreated((event) => {
        addWorkspace(event.projectPath, event.workspace);
      })
    );

    subscriptions.push(
      api.onWorkspaceRemoved((event) => {
        removeWorkspace(event.projectPath, event.workspacePath);
      })
    );

    subscriptions.push(
      api.onWorkspaceSwitched((event) => {
        setActiveWorkspace(event.workspacePath);
      })
    );

    // Cleanup all subscriptions on unmount
    return () => {
      subscriptions.forEach((unsub) => unsub());
    };
  });

  // Handle opening a project
  async function handleOpenProject(): Promise<void> {
    const path = await api.selectFolder();
    if (path) {
      await api.openProject(path);
    }
  }

  // Handle closing a project
  async function handleCloseProject(path: ProjectPath): Promise<void> {
    await api.closeProject(path);
  }

  // Handle switching workspace
  async function handleSwitchWorkspace(workspacePath: string): Promise<void> {
    await api.switchWorkspace(workspacePath);
  }

  // Handle opening create dialog
  function handleOpenCreateDialog(projectPath: string, triggerId: string): void {
    openCreateDialog(projectPath, triggerId);
  }

  // Handle opening remove dialog
  function handleOpenRemoveDialog(workspacePath: string, triggerId: string): void {
    openRemoveDialog(workspacePath, triggerId);
  }
</script>

<svelte:window onkeydown={handleKeyDown} onkeyup={handleKeyUp} onblur={handleWindowBlur} />

<main class="app">
  <Sidebar
    projects={projects.value}
    activeWorkspacePath={activeWorkspacePath.value}
    loadingState={loadingState.value}
    loadingError={loadingError.value}
    shortcutModeActive={shortcutModeActive.value}
    onOpenProject={handleOpenProject}
    onCloseProject={handleCloseProject}
    onSwitchWorkspace={handleSwitchWorkspace}
    onOpenCreateDialog={handleOpenCreateDialog}
    onOpenRemoveDialog={handleOpenRemoveDialog}
  />
</main>

{#if dialogState.value.type === "create"}
  <CreateWorkspaceDialog open={true} projectPath={dialogState.value.projectPath} />
{:else if dialogState.value.type === "remove"}
  <RemoveWorkspaceDialog open={true} workspacePath={dialogState.value.workspacePath} />
{/if}

<ShortcutOverlay
  active={shortcutModeActive.value}
  workspaceCount={getAllWorkspaces().length}
  hasActiveProject={activeProject.value !== undefined}
  hasActiveWorkspace={activeWorkspacePath.value !== null}
/>

<style>
  .app {
    display: flex;
    height: 100%;
    color: var(--ch-foreground);
    background: transparent; /* Allow VS Code to show through UI layer */
  }
</style>
