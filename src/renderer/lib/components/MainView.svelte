<!--
  MainView.svelte
  
  Main application content component that renders when setup is complete.
  Owns IPC initialization for domain events (projects, workspaces, agents).
  
  Note: This component renders inside App.svelte's <main> element.
  It does NOT render its own <main> landmark - App.svelte owns that.
  
  Responsibilities:
  - Initialize IPC calls on mount via initializeApp
  - Subscribe to domain events via setupDomainEventBindings
  - Subscribe to deletion progress via setupDeletionProgress
  - Sync dialog state with main process z-order
  - Render Sidebar, dialogs, and ShortcutOverlay
-->
<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "$lib/api";
  import {
    projects,
    activeWorkspacePath,
    loadingState,
    loadingError,
    getAllWorkspaces,
  } from "$lib/stores/projects.svelte.js";
  import {
    dialogState,
    openCreateDialog,
    openRemoveDialog,
    openCloseProjectDialog,
  } from "$lib/stores/dialogs.svelte.js";
  import {
    shortcutModeActive,
    setDialogOpen,
    syncMode,
    desiredMode,
  } from "$lib/stores/ui-mode.svelte.js";
  import { AgentNotificationService } from "$lib/services/agent-notifications";
  import { createLogger } from "$lib/logging";

  // Setup functions
  import { setupDeletionProgress } from "$lib/utils/setup-deletion-progress";
  import { setupDomainEventBindings } from "$lib/utils/setup-domain-event-bindings";
  import { initializeApp } from "$lib/utils/initialize-app";

  // Components
  import Sidebar from "./Sidebar.svelte";
  import CreateWorkspaceDialog from "./CreateWorkspaceDialog.svelte";
  import RemoveWorkspaceDialog from "./RemoveWorkspaceDialog.svelte";
  import CloseProjectDialog from "./CloseProjectDialog.svelte";
  import OpenProjectErrorDialog from "./OpenProjectErrorDialog.svelte";
  import ShortcutOverlay from "./ShortcutOverlay.svelte";
  import DeletionProgressView from "./DeletionProgressView.svelte";
  import Logo from "./Logo.svelte";

  import {
    clearDeletion,
    getDeletionState,
    getDeletionStatus,
  } from "$lib/stores/deletion.svelte.js";
  import type { ProjectId, WorkspaceRef } from "$lib/api";
  import { getErrorMessage } from "@shared/error-utils";

  const logger = createLogger("ui");

  // Container ref for focus management
  let containerRef: HTMLElement;

  // Error state for open project dialog
  let openProjectError = $state<string | null>(null);

  // Sync dialog state to central ui-mode store
  $effect(() => {
    const isDialogOpen = dialogState.value.type !== "closed";
    setDialogOpen(isDialogOpen);
  });

  // Sync desiredMode with main process (single IPC sync point)
  // Note: desiredMode.value is accessed to establish reactive dependency,
  // then syncMode() reads it internally and sends to main process
  $effect(() => {
    void desiredMode.value;
    syncMode();
  });

  // Derive deletion state for active workspace
  const activeDeletionState = $derived(
    activeWorkspacePath.value ? getDeletionState(activeWorkspacePath.value) : undefined
  );

  // Initialize and subscribe to events on mount
  onMount(() => {
    const notificationService = new AgentNotificationService();

    // Compose setup functions - each returns cleanup callback
    const cleanupDeletion = setupDeletionProgress();
    const cleanupDomainEvents = setupDomainEventBindings(notificationService);

    // Window event listener - inline (single use case, no abstraction needed)
    const handleOpenProjectEvent = (): void => {
      void handleOpenProject();
    };
    window.addEventListener("codehydra:open-project", handleOpenProjectEvent);

    // Initialize app (async with no-op cleanup for consistent composition)
    let cleanupInit = (): void => {};
    void initializeApp({
      containerRef,
      notificationService,
      onAutoOpenProject: handleOpenProject,
    }).then((cleanup) => {
      cleanupInit = cleanup;
    });

    // Combined cleanup
    return () => {
      cleanupDeletion();
      cleanupDomainEvents();
      cleanupInit();
      window.removeEventListener("codehydra:open-project", handleOpenProjectEvent);
    };
  });

  // Handle opening a project
  async function handleOpenProject(): Promise<void> {
    const path = await api.ui.selectFolder();
    if (!path) return;

    try {
      await api.projects.open(path);
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("Failed to open project", { path, error: message });
      openProjectError = message;
    }
  }

  // Handle retry from open project error dialog
  async function handleOpenProjectRetry(): Promise<void> {
    const path = await api.ui.selectFolder();
    if (!path) {
      // User cancelled folder picker - keep dialog open with original error
      return;
    }
    // Clear error and try opening the new path
    openProjectError = null;
    try {
      await api.projects.open(path);
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("Failed to open project", { path, error: message });
      openProjectError = message;
    }
  }

  // Handle close from open project error dialog
  function handleOpenProjectErrorClose(): void {
    openProjectError = null;
  }

  // Handle closing a project
  function handleCloseProject(projectId: ProjectId): void {
    const project = projects.value.find((p) => p.id === projectId);
    if (!project) {
      // Project already closed or not in store - early return
      return;
    }
    // Always show dialog for closing projects, even if empty
    // User should confirm they want to stop tracking the project
    logger.debug("Dialog opened", { type: "close-project" });
    openCloseProjectDialog(projectId);
  }

  // Handle switching workspace
  async function handleSwitchWorkspace(workspaceRef: WorkspaceRef): Promise<void> {
    logger.debug("Workspace selected", { workspaceName: workspaceRef.workspaceName });
    await api.ui.switchWorkspace(workspaceRef.projectId, workspaceRef.workspaceName);
  }

  // Handle opening create dialog
  function handleOpenCreateDialog(projectId: ProjectId): void {
    logger.debug("Dialog opened", { type: "create-workspace" });
    openCreateDialog(projectId);
  }

  // Handle opening remove dialog
  function handleOpenRemoveDialog(workspaceRef: WorkspaceRef): void {
    logger.debug("Dialog opened", { type: "remove-workspace" });
    openRemoveDialog(workspaceRef);
  }

  // Handle retry deletion
  function handleRetry(): void {
    if (!activeDeletionState) return;
    logger.debug("Retrying deletion", { workspaceName: activeDeletionState.workspaceName });
    // Fire-and-forget - new progress events will update the state
    // Pass skipSwitch: true to prevent switching away from this workspace on retry
    void api.workspaces.remove(
      activeDeletionState.projectId,
      activeDeletionState.workspaceName,
      activeDeletionState.keepBranch,
      true // skipSwitch - user explicitly selected this workspace to retry
    );
  }

  // Handle close anyway (force remove)
  async function handleCloseAnyway(): Promise<void> {
    if (!activeDeletionState) return;
    logger.debug("Force removing workspace", { workspaceName: activeDeletionState.workspaceName });
    try {
      await api.workspaces.forceRemove(
        activeDeletionState.projectId,
        activeDeletionState.workspaceName
      );
      clearDeletion(activeDeletionState.workspacePath);
    } catch (error) {
      logger.warn("Force remove failed", { error: getErrorMessage(error) });
    }
  }
</script>

<div class="main-view" bind:this={containerRef}>
  <Sidebar
    projects={projects.value}
    activeWorkspacePath={activeWorkspacePath.value}
    loadingState={loadingState.value}
    loadingError={loadingError.value}
    shortcutModeActive={shortcutModeActive.value}
    totalWorkspaces={getAllWorkspaces().length}
    onOpenProject={handleOpenProject}
    onCloseProject={handleCloseProject}
    onSwitchWorkspace={handleSwitchWorkspace}
    onOpenCreateDialog={handleOpenCreateDialog}
    onOpenRemoveDialog={handleOpenRemoveDialog}
  />

  {#if dialogState.value.type === "create"}
    <CreateWorkspaceDialog open={true} projectId={dialogState.value.projectId} />
  {:else if dialogState.value.type === "remove"}
    <RemoveWorkspaceDialog open={true} workspaceRef={dialogState.value.workspaceRef} />
  {:else if dialogState.value.type === "close-project"}
    <CloseProjectDialog open={true} projectId={dialogState.value.projectId} />
  {/if}

  <OpenProjectErrorDialog
    open={openProjectError !== null}
    errorMessage={openProjectError ?? ""}
    onRetry={handleOpenProjectRetry}
    onClose={handleOpenProjectErrorClose}
  />

  <ShortcutOverlay
    active={shortcutModeActive.value}
    workspaceCount={getAllWorkspaces().length}
    hasActiveProject={projects.value.length > 0}
    hasActiveWorkspace={activeWorkspacePath.value !== null}
    activeWorkspaceDeletionInProgress={activeWorkspacePath.value !== null &&
      getDeletionStatus(activeWorkspacePath.value) === "in-progress"}
  />

  <!-- Backdrop shown only when no workspace is active, to avoid white background -->
  <!-- Show DeletionProgressView if active workspace is being deleted -->
  {#if activeDeletionState}
    <DeletionProgressView
      progress={activeDeletionState}
      onRetry={handleRetry}
      onCloseAnyway={handleCloseAnyway}
    />
  {:else if activeWorkspacePath.value === null}
    <div class="empty-backdrop" aria-hidden="true">
      <div class="backdrop-logo">
        <Logo animated={false} />
      </div>
    </div>
  {/if}
</div>

<style>
  .main-view {
    position: relative;
    display: flex;
    width: 100vw;
    height: 100vh;
    color: var(--ch-foreground);
    background: transparent; /* Allow VS Code to show through UI layer */
  }

  .empty-backdrop {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: var(--ch-sidebar-minimized-width, 20px);
    background: var(--ch-background);
    z-index: -1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .backdrop-logo {
    opacity: var(--ch-logo-backdrop-opacity, 0.15);
  }

  .backdrop-logo :global(img) {
    width: min(256px, 30vw);
    height: min(256px, 30vw);
  }
</style>
