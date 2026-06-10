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
    activeWorkspace,
    getAllWorkspaces,
    setActiveWorkspace,
  } from "$lib/stores/projects.svelte.js";
  import { bootstrap } from "$lib/stores/bootstrap.svelte.js";
  import {
    dialogState,
    openRemoveDialog,
    openCloseProjectDialog,
    closeDialog,
  } from "$lib/stores/dialogs.svelte.js";
  import {
    newWorkspaceView,
    openNewWorkspaceView,
    closeNewWorkspaceView,
  } from "$lib/stores/new-workspace-view.svelte.js";
  import {
    shortcutModeActive,
    setDialogOpen,
    setNewWorkspaceViewOpen,
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
  import NotificationHost from "./NotificationHost.svelte";
  import NewWorkspaceView from "./NewWorkspaceView.svelte";
  import RemoveWorkspaceDialog from "./RemoveWorkspaceDialog.svelte";
  import CloseProjectDialog from "./CloseProjectDialog.svelte";
  import GitCloneDialog from "./GitCloneDialog.svelte";
  import OpenProjectErrorDialog from "./OpenProjectErrorDialog.svelte";
  import ShortcutOverlay from "./ShortcutOverlay.svelte";
  import HibernatedOverlay from "./HibernatedOverlay.svelte";
  import Logo from "./Logo.svelte";

  import { getLifecycle, lifecycleEntries } from "$lib/stores/workspace-lifecycle.svelte.js";
  import { hasSpinnerNotifications } from "$lib/stores/notification-store.svelte.js";
  import { getStatus } from "$lib/stores/agent-status.svelte.js";
  import {
    dialogs,
    panelDialog,
    processCommand as processFrameworkDialog,
  } from "$lib/stores/dialog-framework.svelte.js";
  import PanelView from "./PanelView.svelte";
  import type { ProjectId, WorkspaceRef } from "$lib/api";
  import { getErrorMessage } from "@shared/error-utils";

  const logger = createLogger("ui");

  // Container ref for focus management
  let containerRef: HTMLElement;

  // Error state for open project dialog
  let openProjectError = $state<string | null>(null);

  // Sync dialog state to central ui-mode store
  // Includes both renderer-side dialogs (create/remove) and declarative framework dialogs
  $effect(() => {
    const hasModalFrameworkDialog = [...dialogs.value.values()].some((entry) => entry.config.modal);
    const isDialogOpen = dialogState.value.type !== "closed" || hasModalFrameworkDialog;
    setDialogOpen(isDialogOpen);
  });

  // Close renderer-side dialog when a modal framework dialog opens
  // (framework dialogs have lower z-index and would be hidden otherwise)
  $effect(() => {
    const hasModalFrameworkDialog = [...dialogs.value.values()].some((entry) => entry.config.modal);
    if (hasModalFrameworkDialog && dialogState.value.type !== "closed") {
      closeDialog();
    }
  });

  // Sync desiredMode with main process (single IPC sync point)
  // Note: desiredMode.value is accessed to establish reactive dependency,
  // then syncMode() reads it internally and sends to main process
  $effect(() => {
    void desiredMode.value;
    syncMode();
  });

  // Effective workspace count excludes workspaces with active (non-failed) deletions.
  // This lets us show the Create Workspace dialog as soon as the last workspace's
  // deletion begins, rather than waiting for the full deletion pipeline to complete.
  const effectiveWorkspaceCount = $derived.by(() => {
    const allWorkspaces = getAllWorkspaces();
    const entries = lifecycleEntries.value;
    return allWorkspaces.filter((ws) => {
      const entry = entries.get(ws.path);
      if (!entry || entry.kind === "creating") return true;
      if (entry.progress.completed && entry.progress.hasErrors) return true;
      return false;
    }).length;
  });

  // Keep the central ui-mode store informed so the UI layer stays on top (at
  // hover level, which still allows Alt+X) while the New workspace view is shown.
  $effect(() => {
    setNewWorkspaceViewOpen(newWorkspaceView.isOpen);
  });

  // When the New workspace view opens, dismiss any MODAL framework dialogs the
  // main process opened in the meantime (most notably the "Loading workspace..."
  // progress dialog triggered by `workspace:loading`). They render inside the
  // UI's DialogHost, so without this they cover the panel until the workspace
  // finishes loading. The sidebar's red "busy" indicator is sufficient
  // feedback that creation is in progress. Panel-surface sessions are left
  // alone — they live in the content area, not on top of it.
  $effect(() => {
    if (!newWorkspaceView.isOpen) return;
    for (const entry of [...dialogs.value.values()]) {
      if (entry.surface !== "modal") continue;
      processFrameworkDialog({ action: "close", dialogId: entry.dialogId });
    }
  });

  // Auto-open the New workspace view as the empty state: when no workspaces
  // exist (real count minus active deletions), it's the natural landing spot.
  // Replaces the old auto-shown Create Workspace dialog + logo backdrop.
  // Debounced to avoid flicker during rapid state changes (e.g., after deletion).
  // Never auto-closes: creating in the background leaves the user on the view.
  let autoOpenTimeout: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const effectiveCount = effectiveWorkspaceCount;
    const initialized = bootstrap.initialized;
    const dialog = dialogState.value;

    if (autoOpenTimeout !== null) {
      clearTimeout(autoOpenTimeout);
      autoOpenTimeout = null;
    }

    // Suppress while a clone runs (a project is about to appear silently) or a
    // framework dialog is open (e.g. git init confirmation).
    const cloneRunning = hasSpinnerNotifications.value;
    const hasFrameworkDialog = dialogs.value.size > 0;
    if (
      effectiveCount === 0 &&
      initialized &&
      dialog.type === "closed" &&
      !cloneRunning &&
      !hasFrameworkDialog &&
      !newWorkspaceView.isOpen
    ) {
      autoOpenTimeout = setTimeout(() => {
        openNewWorkspaceView();
      }, 100);
    }

    return () => {
      if (autoOpenTimeout !== null) {
        clearTimeout(autoOpenTimeout);
      }
    };
  });

  // Leaving the New workspace view is handled explicitly where navigation
  // originates: clicking a workspace (handleSwitchWorkspace) and the shortcut-mode
  // navigation handlers both call closeNewWorkspaceView(). Creating in the
  // background intentionally does NOT switch, so the view stays open afterwards.

  // Derive count of idle workspaces for shortcut overlay
  const idleWorkspaceCount = $derived(
    getAllWorkspaces().filter((ws) => getStatus(ws.path).type === "idle").length
  );

  // The active workspace is hibernated when its metadata flag is set.
  // Looked up against the workspace list because activeWorkspace is just a ref.
  const activeHibernated = $derived.by(() => {
    const ref = activeWorkspace.value;
    if (!ref) return false;
    const project = projects.value.find((p) => p.id === ref.projectId);
    const workspace = project?.workspaces.find((w) => w.path === ref.path);
    return workspace?.metadata?.["hibernated"] === "true";
  });

  // Initialize and subscribe to events on mount
  onMount(() => {
    const notificationService = new AgentNotificationService();

    // Compose setup functions - each returns cleanup callback
    const cleanupDeletion = setupDeletionProgress();
    const cleanupDomainEvents = setupDomainEventBindings(notificationService);

    // Initialize app (async with no-op cleanup for consistent composition)
    let cleanupInit = (): void => {};
    void initializeApp({
      containerRef,
    }).then((cleanup) => {
      cleanupInit = cleanup;
    });

    // Combined cleanup
    return () => {
      cleanupDeletion();
      cleanupDomainEvents();
      cleanupInit();
    };
  });

  // Handle retry from open project error dialog
  async function handleOpenProjectRetry(): Promise<void> {
    // Prevent sidebar collapse while native dialog is open (Windows focus issue)
    setDialogOpen(true);
    try {
      const project = await api.projects.open();
      if (!project) {
        // User cancelled folder picker - keep dialog open with original error
        return;
      }
      // Clear error on success
      openProjectError = null;
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("Failed to open project", { error: message });
      openProjectError = message;
    } finally {
      setDialogOpen(false);
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
    // Leaving the New workspace view by selecting a workspace.
    closeNewWorkspaceView();
    // Set active eagerly so the empty-backdrop doesn't flash during the IPC
    // round-trip — opening the panel cleared the previous active workspace.
    setActiveWorkspace(workspaceRef.path);
    await api.ui.switchWorkspace(workspaceRef.path);
  }

  // Handle opening the New workspace view (global sidebar entry)
  function handleOpenNewWorkspace(): void {
    logger.debug("New workspace view opened");
    openNewWorkspaceView();
  }

  // Handle opening remove dialog
  function handleOpenRemoveDialog(workspaceRef: WorkspaceRef): void {
    logger.debug("Dialog opened", { type: "remove-workspace" });
    openRemoveDialog(workspaceRef);
  }
</script>

<div class="main-view" bind:this={containerRef}>
  <NotificationHost />
  <Sidebar
    projects={projects.value}
    activeWorkspacePath={activeWorkspacePath.value}
    shortcutModeActive={shortcutModeActive.value}
    totalWorkspaces={getAllWorkspaces().length}
    newWorkspaceViewOpen={newWorkspaceView.isOpen}
    onCloseProject={handleCloseProject}
    onSwitchWorkspace={handleSwitchWorkspace}
    onOpenNewWorkspace={handleOpenNewWorkspace}
    onOpenRemoveDialog={handleOpenRemoveDialog}
  />

  {#if dialogState.value.type === "remove"}
    <RemoveWorkspaceDialog open={true} workspaceRef={dialogState.value.workspaceRef} />
  {:else if dialogState.value.type === "close-project"}
    <CloseProjectDialog open={true} projectId={dialogState.value.projectId} />
  {:else if dialogState.value.type === "git-clone"}
    <GitCloneDialog open={true} />
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
    hasActiveWorkspace={activeWorkspacePath.value !== null}
    {activeHibernated}
    activeWorkspaceDeletionInProgress={activeWorkspacePath.value !== null &&
      getLifecycle(activeWorkspacePath.value) === "deleting"}
    {idleWorkspaceCount}
  />

  <!-- New workspace view: full-area panel; also serves as the empty state -->
  <NewWorkspaceView open={newWorkspaceView.isOpen} />

  <!-- Panel surface: backend-driven form session docked in the content area.
       Visible iff a panel-surface session exists (session-driven visibility). -->
  {#if panelDialog.value}
    <PanelView dialogId={panelDialog.value.dialogId} config={panelDialog.value.config} />
  {/if}

  <!-- Backdrop shown when no workspace is active and the panel is closed -->
  {#if activeWorkspacePath.value === null && !newWorkspaceView.isOpen}
    <div class="empty-backdrop" aria-hidden="true">
      <div class="backdrop-logo">
        <Logo animated={false} />
      </div>
    </div>
  {:else if activeWorkspacePath.value !== null && activeHibernated && activeWorkspace.value}
    <HibernatedOverlay workspaceRef={activeWorkspace.value} />
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
    background: var(--ch-surface-0, var(--ch-background));
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
