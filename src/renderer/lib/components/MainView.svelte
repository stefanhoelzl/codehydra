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
  import {
    dialogState,
    openCreateDialog,
    openRemoveDialog,
    openCloseProjectDialog,
  } from "$lib/stores/dialogs.svelte.js";
  import { shortcutModeActive } from "$lib/stores/shortcuts.svelte.js";
  import { setDialogOpen, syncMode, desiredMode } from "$lib/stores/ui-mode.svelte.js";
  import { updateStatus, setAllStatuses } from "$lib/stores/agent-status.svelte.js";
  import { setupDomainEvents } from "$lib/utils/domain-events";
  import { AgentNotificationService } from "$lib/services/agent-notifications";
  import Sidebar from "./Sidebar.svelte";
  import CreateWorkspaceDialog from "./CreateWorkspaceDialog.svelte";
  import RemoveWorkspaceDialog from "./RemoveWorkspaceDialog.svelte";
  import CloseProjectDialog from "./CloseProjectDialog.svelte";
  import ShortcutOverlay from "./ShortcutOverlay.svelte";
  import Logo from "./Logo.svelte";
  import type { ProjectId, WorkspaceRef } from "$lib/api";
  import type { AggregatedAgentStatus } from "@shared/ipc";
  import type { Project, WorkspaceStatus, AgentStatus } from "@shared/api/types";

  // Container ref for focus management
  let containerRef: HTMLElement;

  /**
   * Convert v2 AgentStatus to old AggregatedAgentStatus format.
   * The old format uses 'status' field, v2 uses 'type' field.
   */
  function toAggregatedStatus(agent: AgentStatus): AggregatedAgentStatus {
    if (agent.type === "none") {
      return { status: "none", counts: { idle: 0, busy: 0 } };
    }
    // Strip 'total' from counts as old format doesn't have it
    return { status: agent.type, counts: { idle: agent.counts.idle, busy: agent.counts.busy } };
  }

  /**
   * Fetch all workspace statuses using v2 API and convert to old format.
   * Iterates all workspaces across all projects.
   */
  async function fetchAllAgentStatuses(
    projectList: readonly Project[]
  ): Promise<Record<string, AggregatedAgentStatus>> {
    const result: Record<string, AggregatedAgentStatus> = {};

    // Fetch status for each workspace in parallel
    const statusPromises: Promise<void>[] = [];
    for (const project of projectList) {
      for (const workspace of project.workspaces) {
        const promise = api.workspaces
          .getStatus(project.id, workspace.name)
          .then((status: WorkspaceStatus) => {
            result[workspace.path] = toAggregatedStatus(status.agent);
          })
          .catch(() => {
            // Ignore errors for individual workspaces
          });
        statusPromises.push(promise);
      }
    }
    await Promise.all(statusPromises);
    return result;
  }

  // Sync dialog state to central ui-mode store
  $effect(() => {
    const isDialogOpen = dialogState.value.type !== "closed";
    setDialogOpen(isDialogOpen);
    // Note: shortcutModeActive guard not needed - ui-mode store handles priority
  });

  // Sync desiredMode with main process (single IPC sync point)
  $effect(() => {
    // Access desiredMode to track it, then sync
    void desiredMode.value;
    syncMode();
  });

  // Initialize and subscribe to domain events on mount
  onMount(() => {
    // Create notification service for chime sounds when agents become idle
    // This must be created before setupDomainEvents so we can seed it with initial statuses
    const notificationService = new AgentNotificationService();

    // Initialize - load projects, agent statuses, and optionally auto-open picker
    const initProjectsAndStatuses = async (): Promise<void> => {
      try {
        // Use v2 API for listing projects (returns projects with IDs)
        const projectList = await api.projects.list();
        // v2 projects have IDs - store now accepts v2 Project type directly
        setProjects([...projectList]);

        // Get initial active workspace from main process state
        const activeRef = await api.ui.getActiveWorkspace();
        if (activeRef) {
          setActiveWorkspace(activeRef.path);
        }
        setLoaded();

        // Focus first focusable element after DOM settles with project list rendered
        await tick();
        const firstFocusable = containerRef?.querySelector<HTMLElement>(
          'button:not([tabindex="-1"]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        firstFocusable?.focus();

        // Fetch agent statuses for all workspaces using v2 API
        try {
          const statuses = await fetchAllAgentStatuses(projectList);
          setAllStatuses(statuses);
          // Seed notification service with initial counts so chimes work on first status change
          const initialCounts = Object.fromEntries(
            Object.entries(statuses).map(([path, status]) => [path, status.counts])
          );
          notificationService.seedInitialCounts(initialCounts);
        } catch {
          // Agent status is optional, don't fail if it doesn't work
        }

        // Auto-open project picker when no projects exist (first launch experience)
        if (projectList.length === 0) {
          await handleOpenProject();
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load projects");
      }
    };
    void initProjectsAndStatuses();

    // Subscribe to domain events using API helper
    // API uses ProjectId and WorkspaceRef instead of paths.
    // Store functions accept API types directly.
    // Cast api to DomainEventApi since preload has looser typing
    const cleanup = setupDomainEvents(
      api as import("$lib/utils/domain-events").DomainEventApi,
      {
        addProject: (project) => {
          // Project format - store accepts directly
          addProject(project);
        },
        removeProject: (projectId) => {
          // Find project by ID and remove by path
          const project = projects.value.find((p) => p.id === projectId);
          if (project) {
            removeProject(project.path);
          }
        },
        addWorkspace: (projectId, workspace) => {
          // Find project by ID to get path
          const project = projects.value.find((p) => p.id === projectId);
          if (project) {
            addWorkspace(project.path, workspace);
          }
        },
        removeWorkspace: (ref) => {
          // Find project by ID to get path
          const project = projects.value.find((p) => p.id === ref.projectId);
          if (project) {
            removeWorkspace(project.path, ref.path);
          }
        },
        setActiveWorkspace: (ref) => {
          // uses WorkspaceRef | null, store uses path | null
          setActiveWorkspace(ref?.path ?? null);
        },
        updateAgentStatus: (ref, status) => {
          // Convert WorkspaceStatus to AggregatedAgentStatus
          updateStatus(ref.path, toAggregatedStatus(status.agent));
        },
      },
      {
        // Auto-open create dialog when project has no workspaces
        onProjectOpenedHook: (project) => {
          if (project.workspaces.length === 0 && dialogState.value.type === "closed") {
            openCreateDialog(project.id);
          }
        },
      },
      {
        // Pass in our notification service so it receives status change events
        notificationService,
      }
    );

    // Cleanup subscriptions on unmount
    return cleanup;
  });

  // Handle opening a project
  async function handleOpenProject(): Promise<void> {
    const path = await api.ui.selectFolder();
    if (path) {
      await api.projects.open(path);
    }
  }

  // Handle closing a project
  async function handleCloseProject(projectId: ProjectId): Promise<void> {
    const project = projects.value.find((p) => p.id === projectId);
    if (!project) {
      // Project already closed or not in store - early return
      return;
    }
    if (project.workspaces.length > 0) {
      openCloseProjectDialog(projectId);
    } else {
      await api.projects.close(projectId);
    }
  }

  // Handle switching workspace
  async function handleSwitchWorkspace(workspaceRef: WorkspaceRef): Promise<void> {
    await api.ui.switchWorkspace(workspaceRef.projectId, workspaceRef.workspaceName);
  }

  // Handle opening create dialog
  function handleOpenCreateDialog(projectId: ProjectId): void {
    openCreateDialog(projectId);
  }

  // Handle opening remove dialog
  function handleOpenRemoveDialog(workspaceRef: WorkspaceRef): void {
    openRemoveDialog(workspaceRef);
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

  <ShortcutOverlay
    active={shortcutModeActive.value}
    workspaceCount={getAllWorkspaces().length}
    hasActiveProject={projects.value.length > 0}
    hasActiveWorkspace={activeWorkspacePath.value !== null}
  />

  <!-- Backdrop shown only when no workspace is active, to avoid white background -->
  {#if activeWorkspacePath.value === null}
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
