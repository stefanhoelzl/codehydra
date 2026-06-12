<!--
  MainView.svelte

  Main application content component that renders when setup is complete.
  Renders from the UiState snapshot (read cutover): the main process presenter
  pushes the full render-ready view-model on api:ui:state; this component is a
  render function over it plus the renderer-local stores that have not yet
  migrated (dialogs, ui-mode, notifications).

  Note: This component renders inside App.svelte's <main> element.
  It does NOT render its own <main> landmark - App.svelte owns that.

  Responsibilities:
  - Initialize IPC on mount via initializeApp (subscribes to ui:state, then
    signals lifecycle.ready())
  - Subscribe to the surviving domain events (notification chimes) via
    setupDomainEventBindings
  - Sync dialog state with main process z-order
  - Render Sidebar, WorkspaceFrames, dialogs, panel, and ShortcutOverlay
-->
<script lang="ts">
  import { onMount, untrack } from "svelte";
  import * as api from "$lib/api";
  import { uiState } from "$lib/stores/ui-state.svelte.js";
  import {
    dialogState,
    openRemoveDialog,
    openCloseProjectDialog,
    closeDialog,
  } from "$lib/stores/dialogs.svelte.js";
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
  import { setupDomainEventBindings } from "$lib/utils/setup-domain-event-bindings";
  import { initializeApp } from "$lib/utils/initialize-app";

  // Components
  import Sidebar from "./Sidebar.svelte";
  import WorkspaceFrames from "./WorkspaceFrames.svelte";
  import NotificationHost from "./NotificationHost.svelte";
  import RemoveWorkspaceDialog from "./RemoveWorkspaceDialog.svelte";
  import CloseProjectDialog from "./CloseProjectDialog.svelte";
  import ShortcutOverlay from "./ShortcutOverlay.svelte";
  import HibernatedOverlay from "./HibernatedOverlay.svelte";

  import {
    dialogs,
    panelDialog,
    processCommand as processFrameworkDialog,
  } from "$lib/stores/dialog-framework.svelte.js";
  import PanelView from "./PanelView.svelte";
  import type { ProjectId, WorkspaceRef } from "$lib/api";

  const logger = createLogger("ui");

  // Container ref for focus management
  let containerRef: HTMLElement;

  // ============ Snapshot-derived views ============
  // uiState is null until the genesis push arrives (milliseconds after
  // lifecycle.ready()); until then the sidebar is empty and main shows
  // nothing — same as today's pre-population frame.

  const ui = $derived(uiState.value);
  const projectRows = $derived(ui?.sidebar.projects ?? []);
  const main = $derived(ui?.main ?? null);
  /** The creation panel is the ground state: shown whenever main says so. */
  const creationShown = $derived(main?.kind === "creation");

  /** All workspace rows in sidebar display order. */
  const allRows = $derived(projectRows.flatMap((project) => project.workspaces));
  const totalWorkspaces = $derived(allRows.length);
  const idleWorkspaceCount = $derived(allRows.filter((row) => row.agent.type === "idle").length);
  const activeRow = $derived(allRows.find((row) => row.active) ?? null);

  // Frames with accessible titles: the snapshot's frames region carries only
  // key → URL; the iframe title (workspace name) is joined from the sidebar
  // rows. Display-only transitional join.
  const frameEntries = $derived.by(() => {
    const names = new Map(allRows.map((row) => [row.key, row.name]));
    return Object.entries(ui?.frames ?? {}).map(([key, url]) => ({
      key,
      url,
      title: names.get(key) ?? "workspace",
    }));
  });
  const activeFrameKey = $derived(main?.kind === "workspace" ? main.frameKey : null);

  // ============ ui-mode sync ============

  // Sync dialog state to central ui-mode store
  // Includes both renderer-side dialogs (remove/close-project) and declarative framework dialogs
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

  // Keep the central ui-mode store informed so the UI layer stays on top (at
  // hover level, which still allows Alt+X) while the creation panel is shown.
  $effect(() => {
    setNewWorkspaceViewOpen(creationShown);
  });

  // At the moment the creation panel is shown, dismiss MODAL framework
  // dialogs the main process opened in the meantime (most notably the
  // "Loading workspace..." progress dialog triggered by `workspace:loading`).
  // They render inside the UI's DialogHost, so without this they would cover
  // the panel. Transition-based (not continuous): modal dialogs opened WHILE
  // the panel is shown — e.g. the creation module's git-clone sub-dialog —
  // must stay. Panel-surface sessions are left alone.
  let prevShownForModalSweep = false;
  $effect(() => {
    const shown = creationShown;
    if (shown && !prevShownForModalSweep) {
      for (const entry of untrack(() => [...dialogs.value.values()])) {
        if (entry.surface !== "modal") continue;
        processFrameworkDialog({ action: "close", dialogId: entry.dialogId });
      }
    }
    prevShownForModalSweep = shown;
  });

  // Request a fresh form whenever the panel is (re)shown: send a dismiss
  // event so the backend creation module resets its session (close + reopen
  // with fresh config = new dialogId). Sent once per show transition, also
  // covering the startup race where the snapshot shows the panel before the
  // always-alive session has arrived. NOT re-sent when the dialogId changes
  // mid-show — that change IS the reset.
  let showDismissPending = false;
  let prevShownForDismiss = false;
  $effect(() => {
    const shown = creationShown;
    if (shown && !prevShownForDismiss) showDismissPending = true;
    if (!shown) showDismissPending = false;
    prevShownForDismiss = shown;
    const session = panelDialog.value;
    if (showDismissPending && session) {
      showDismissPending = false;
      api.sendDialogEvent({ kind: "dismiss", dialogId: session.dialogId });
    }
  });

  // Initialize and subscribe to events on mount
  onMount(() => {
    const notificationService = new AgentNotificationService();

    // Surviving domain-event bindings (notification chimes)
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
      cleanupDomainEvents();
      cleanupInit();
    };
  });

  // Handle closing a project
  function handleCloseProject(projectId: ProjectId): void {
    if (!projectRows.some((project) => project.id === projectId)) {
      return;
    }
    // Always show dialog for closing projects, even if empty
    // User should confirm they want to stop tracking the project
    logger.debug("Dialog opened", { type: "close-project" });
    openCloseProjectDialog(projectId);
  }

  // Handle switching workspace. No eager local state: the snapshot push
  // following workspace:switched flips the frame (and leaves the panel when
  // it was showing — selecting a workspace deselects the panel by design).
  async function handleSwitchWorkspace(workspaceRef: WorkspaceRef): Promise<void> {
    logger.debug("Workspace selected", { workspaceName: workspaceRef.workspaceName });
    await api.ui.switchWorkspace(workspaceRef.path);
  }

  // Handle opening the creation panel (global sidebar entry): deselect.
  // No workspace active = the panel is the main view (ground state).
  function handleOpenNewWorkspace(): void {
    logger.debug("New workspace view opened");
    void api.ui.switchWorkspace(null);
  }

  // Handle opening remove dialog
  function handleOpenRemoveDialog(workspaceRef: WorkspaceRef): void {
    logger.debug("Dialog opened", { type: "remove-workspace" });
    openRemoveDialog(workspaceRef);
  }
</script>

<div class="main-view" bind:this={containerRef}>
  <WorkspaceFrames frames={frameEntries} activeKey={activeFrameKey} />
  <NotificationHost />
  <Sidebar
    projects={projectRows}
    shortcutModeActive={shortcutModeActive.value}
    newWorkspaceViewOpen={creationShown}
    onCloseProject={handleCloseProject}
    onSwitchWorkspace={handleSwitchWorkspace}
    onOpenNewWorkspace={handleOpenNewWorkspace}
    onOpenRemoveDialog={handleOpenRemoveDialog}
  />

  {#if dialogState.value.type === "remove"}
    {@const removePath = dialogState.value.workspaceRef.path}
    <RemoveWorkspaceDialog
      workspaceRef={dialogState.value.workspaceRef}
      baseBranch={allRows.find((row) => row.path === removePath)?.base}
    />
  {:else if dialogState.value.type === "close-project"}
    {@const closeId = dialogState.value.projectId}
    <CloseProjectDialog project={projectRows.find((project) => project.id === closeId)} />
  {/if}

  <ShortcutOverlay
    active={shortcutModeActive.value}
    workspaceCount={totalWorkspaces}
    hasActiveWorkspace={activeRow !== null}
    activeHibernated={main?.kind === "hibernated"}
    activeWorkspaceDeletionInProgress={activeRow !== null && activeRow.status === "deleting"}
    {idleWorkspaceCount}
  />

  <!-- Creation panel: the backend creation module's always-alive form
       session, shown while the snapshot's main view is "creation" (the
       ground state when no workspace is active). The creation form is the
       only panel-surface session today; revisit the gating if another panel
       session appears. -->
  {#if creationShown && panelDialog.value}
    <PanelView dialogId={panelDialog.value.dialogId} config={panelDialog.value.config} />
  {/if}

  {#if main?.kind === "hibernated"}
    <HibernatedOverlay screenshot={main.screenshot} />
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
</style>
