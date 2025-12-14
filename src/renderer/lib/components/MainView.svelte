<!--
  MainView.svelte
  
  Main application content component that renders when setup is complete.
  Owns IPC initialization for domain events (projects, workspaces, agents).
  
  Note: This component renders inside App.svelte's <main> element.
  It does NOT render its own <main> landmark - App.svelte owns that.
  
  Responsibilities:
  - Initialize IPC calls on mount (listProjects, getAllAgentStatuses)
  - Subscribe to domain events (project/workspace/agent changes)
  - Sync dialog state with main process z-order
  - Render Sidebar, dialogs, and ShortcutOverlay
-->
<script lang="ts">
  import { onMount, tick } from "svelte";
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
  import { shortcutModeActive } from "$lib/stores/shortcuts.svelte.js";
  import { updateStatus, setAllStatuses } from "$lib/stores/agent-status.svelte.js";
  import { setupDomainEvents } from "$lib/utils/domain-events";
  import { AgentNotificationService } from "$lib/services/agent-notifications";
  import Sidebar from "./Sidebar.svelte";
  import CreateWorkspaceDialog from "./CreateWorkspaceDialog.svelte";
  import RemoveWorkspaceDialog from "./RemoveWorkspaceDialog.svelte";
  import ShortcutOverlay from "./ShortcutOverlay.svelte";
  import type { ProjectPath } from "$lib/api";

  // Container ref for focus management
  let containerRef: HTMLElement;

  // Sync dialog state with main process z-order and focus
  $effect(() => {
    const isDialogOpen = dialogState.value.type !== "closed";
    void api.setDialogMode(isDialogOpen);
    // When dialog closes and there's an active workspace, focus it
    if (!isDialogOpen && activeWorkspacePath.value) {
      void api.focusActiveWorkspace();
    }
  });

  // Initialize and subscribe to domain events on mount
  onMount(() => {
    // Create notification service for chime sounds when agents become idle
    // This must be created before setupDomainEvents so we can seed it with initial statuses
    const notificationService = new AgentNotificationService();

    // Initialize - load projects and optionally auto-open picker
    const initProjects = async (): Promise<void> => {
      try {
        const result = await api.listProjects();
        setProjects(result.projects);
        // Set initial active workspace from main process state
        if (result.activeWorkspacePath) {
          setActiveWorkspace(result.activeWorkspacePath);
        }
        setLoaded();

        // Auto-open project picker when no projects exist (first launch experience)
        if (result.projects.length === 0) {
          await handleOpenProject();
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load projects");
      }
    };
    void initProjects();

    // Initialize - load agent statuses and seed notification service
    const initAgentStatuses = async (): Promise<void> => {
      try {
        const statuses = await api.getAllAgentStatuses();
        setAllStatuses(statuses);
        // Seed notification service with initial counts so chimes work on first status change
        const initialCounts = Object.fromEntries(
          Object.entries(statuses).map(([path, status]) => [path, status.counts])
        );
        notificationService.seedInitialCounts(initialCounts);
      } catch {
        // Agent status is optional, don't fail if it doesn't work
      }
    };
    void initAgentStatuses();

    // Subscribe to domain events using helper
    const cleanup = setupDomainEvents(
      api,
      {
        addProject,
        removeProject,
        addWorkspace,
        removeWorkspace,
        setActiveWorkspace,
        updateAgentStatus: updateStatus,
      },
      {
        // Auto-open create dialog when project has no workspaces
        onProjectOpenedHook: (project) => {
          if (project.workspaces.length === 0 && dialogState.value.type === "closed") {
            openCreateDialog(project.path);
          }
        },
      },
      {
        // Pass in our notification service so it receives status change events
        notificationService,
      }
    );

    // Focus first focusable element after DOM settles
    const initFocus = async (): Promise<void> => {
      await tick();
      const firstFocusable = containerRef?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      firstFocusable?.focus();
    };
    void initFocus();

    // Cleanup subscriptions on unmount
    return cleanup;
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
  function handleOpenCreateDialog(projectPath: string): void {
    openCreateDialog(projectPath);
  }

  // Handle opening remove dialog
  function handleOpenRemoveDialog(workspacePath: string): void {
    openRemoveDialog(workspacePath);
  }
</script>

<div class="main-view" bind:this={containerRef}>
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

  <!-- Backdrop shown only when no workspace is active, to avoid white background -->
  {#if activeWorkspacePath.value === null}
    <div class="empty-backdrop" aria-hidden="true"></div>
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
    left: var(--ch-sidebar-width);
    background: var(--ch-background);
    z-index: -1;
  }
</style>
