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
    emits the ui-connected handshake)
  - Subscribe to the surviving domain events (notification chimes) via
    setupDomainEventBindings
  - Sync dialog state with main process z-order
  - Render Sidebar, WorkspaceFrames, panel, and ShortcutOverlay. The remove
    and close-project confirmations are main-side declarative dialogs now:
    the gestures emit ui:events and the dialogs arrive via the framework.
-->
<script lang="ts">
  import { onMount, untrack } from "svelte";
  import * as api from "$lib/api";
  import { uiState } from "$lib/stores/ui-state.svelte.js";
  import { AgentNotificationService } from "$lib/services/agent-notifications";
  import { createLogger } from "$lib/logging";

  // Setup functions
  import { setupDomainEventBindings } from "$lib/utils/setup-domain-event-bindings";
  import { initializeApp } from "$lib/utils/initialize-app";

  // Components
  import Sidebar from "./Sidebar.svelte";
  import WorkspaceFrames from "./WorkspaceFrames.svelte";
  import NotificationHost from "./NotificationHost.svelte";
  import ShortcutOverlay from "./ShortcutOverlay.svelte";
  import HibernatedOverlay from "./HibernatedOverlay.svelte";

  import {
    dialogs,
    panelDialog,
    processCommand as processFrameworkDialog,
  } from "$lib/stores/dialog-framework.svelte.js";
  import PanelView from "./PanelView.svelte";

  const logger = createLogger("ui");

  // Container ref for focus management
  let containerRef: HTMLElement;

  // ============ Snapshot-derived views ============
  // uiState is null until the genesis push arrives (milliseconds after the
  // ui-connected handshake); until then the sidebar is empty and main shows
  // nothing — same as today's pre-population frame.

  const ui = $derived(uiState.value);
  const projectRows = $derived(ui?.sidebar.projects ?? []);
  const main = $derived(ui?.main ?? null);
  /** The single UI mode (main-owned). Default to "workspace" before genesis. */
  const mode = $derived(ui?.mode ?? "workspace");
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

  // Mode (including dialog/hover z-order) is now computed in main and shipped
  // in the snapshot; the renderer no longer mirrors dialog/hover state back.

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

  // Handle closing a project: request the flow from main (the confirmation
  // dialog opens main-side, parking the project:close dispatch).
  function handleCloseProject(projectId: string): void {
    if (!projectRows.some((project) => project.id === projectId)) {
      return;
    }
    logger.debug("Close project requested", { projectId });
    api.emitEvent({ kind: "close-project", projectId });
  }

  // Handle switching workspace. No eager local state: the snapshot push
  // following workspace:switched flips the frame (and leaves the panel when
  // it was showing — selecting a workspace deselects the panel by design).
  // The opaque row key is echoed back; main resolves it and dispatches.
  function handleSwitchWorkspace(key: string): void {
    logger.debug("Workspace selected", { key });
    api.emitEvent({ kind: "switch-workspace", key });
  }

  // Handle opening the creation panel (global sidebar entry): deselect.
  // No workspace active = the panel is the main view (ground state).
  function handleOpenNewWorkspace(): void {
    logger.debug("New workspace view opened");
    api.emitEvent({ kind: "switch-workspace", key: null });
  }

  // Handle removing a workspace: request the flow from main with the row's
  // snapshot key (the confirmation dialog opens main-side, parking the
  // workspace:delete dispatch).
  function handleRemoveWorkspace(key: string): void {
    logger.debug("Remove workspace requested", { key });
    api.emitEvent({ kind: "remove-workspace", key });
  }

  // Wake the active (hibernated) workspace from the overlay. The opaque row
  // key is echoed back; main resolves it and dispatches the wake.
  function handleWakeActiveWorkspace(): void {
    const row = activeRow;
    if (!row) return;
    api.emitEvent({ kind: "wake-workspace", key: row.key });
  }
</script>

<div class="main-view" bind:this={containerRef}>
  <WorkspaceFrames frames={frameEntries} activeKey={activeFrameKey} {mode} />
  <NotificationHost />
  <Sidebar
    projects={projectRows}
    {mode}
    shortcutModeActive={mode === "shortcut"}
    newWorkspaceViewOpen={creationShown}
    onCloseProject={handleCloseProject}
    onSwitchWorkspace={handleSwitchWorkspace}
    onOpenNewWorkspace={handleOpenNewWorkspace}
    onRemoveWorkspace={handleRemoveWorkspace}
  />

  <ShortcutOverlay
    active={mode === "shortcut"}
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
    <HibernatedOverlay screenshot={main.screenshot} onWake={handleWakeActiveWorkspace} />
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
