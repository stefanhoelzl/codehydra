<!--
  MainView.svelte

  Main application content component that renders when setup is complete.
  Renders from the UiState snapshot (read cutover): the main process presenter
  pushes the full render-ready view-model on api:ui:state; App holds it and
  hands MainView the snapshot as the `ui` prop. This component is a pure render
  function over it — it distributes the fields each leaf renders (sidebar rows,
  notifications, dialogs, mode) as props; there are no renderer stores.

  Note: This component renders inside App.svelte's <main> element.
  It does NOT render its own <main> landmark - App.svelte owns that.

  Responsibilities:
  - Subscribe to the surviving domain events (notification chimes) via
    setupDomainEventBindings on mount
  - Sync dialog state with main process z-order
  - Render Sidebar, WorkspaceFrames, panel, and ShortcutOverlay. The remove
    and close-project confirmations are main-side declarative dialogs now:
    the gestures emit ui:events and the dialogs arrive via the framework.

  The ui:state subscription + ui-connected handshake live in App.svelte now
  (so startup snapshots arrive before MainView mounts).
-->
<script lang="ts">
  import { onMount } from "svelte";
  import * as api from "$lib/api";
  import type { UiState } from "@shared/ui-state";
  import { AgentNotificationService } from "$lib/services/agent-notifications";
  import { createLogger } from "$lib/logging";

  // Setup functions
  import { setupDomainEventBindings } from "$lib/utils/setup-domain-event-bindings";

  // Components
  import Sidebar from "./Sidebar.svelte";
  import WorkspaceFrames from "./WorkspaceFrames.svelte";
  import ShortcutOverlay from "./ShortcutOverlay.svelte";
  import HibernatedOverlay from "./HibernatedOverlay.svelte";

  import PanelView from "./PanelView.svelte";

  interface Props {
    /** The latest snapshot, passed down from App (always non-null here). */
    ui: UiState;
  }

  const { ui }: Props = $props();

  const logger = createLogger("ui");

  // ============ Snapshot-derived views ============
  // App renders MainView only once the genesis snapshot has arrived, so `ui` is
  // always present; the derivations below are plain field reads + view-only
  // joins (the distributor hands leaves the fields they render).

  const projectRows = $derived(ui.sidebar.projects);
  const main = $derived(ui.main);
  /** The single UI mode (main-owned). */
  const mode = $derived(ui.mode);
  /**
   * The always-alive creation form session ("modeless" kind), rendered above
   * the sidebar while main is in the creation ground state. View-only pick over
   * the snapshot's dialogs.
   */
  const creationDialog = $derived(ui.dialogs.find((d) => d.kind === "modeless"));
  /**
   * The deletion progress/failed session ("panel" kind), rendered below the
   * sidebar in place of the (already torn-down) workspace view. The deletion
   * module opens it only while its workspace is the active one.
   */
  const deletionDialog = $derived(ui.dialogs.find((d) => d.kind === "panel"));
  /** Whether a blocking modal is open above the panels (drives panel refocus). */
  const modalAbove = $derived(ui.dialogs.some((d) => d.kind === "modal"));
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
    return Object.entries(ui.frames).map(([key, url]) => ({
      key,
      url,
      title: names.get(key) ?? "workspace",
    }));
  });
  const activeFrameKey = $derived(main?.kind === "workspace" ? main.frameKey : null);

  // The mid-session "Loading workspace…" surface (a still-creating active
  // workspace, no frame yet) is a modal system dialog now, driven by the
  // presenter and rendered by App's DialogHost over the kept-alive frames —
  // MainView no longer renders it. `main` reads `workspace` with a frameKey
  // whose iframe is not mounted yet, so the workspace area is blank underneath.

  // Mode (including dialog/hover z-order) is now computed in main and shipped
  // in the snapshot; the renderer no longer mirrors dialog/hover state back.

  // (The renderer no longer locally closes modal dialogs when the panel shows:
  // dialog lifecycle is backend-owned now, so the snapshot decides what is open
  // — the presenter closes anything that should not coexist with the panel.)

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
    const session = creationDialog;
    if (showDismissPending && session) {
      showDismissPending = false;
      api.sendDialogEvent({ kind: "dismiss", dialogId: session.id });
    }
  });

  // Subscribe to the surviving domain events (notification chimes) on mount.
  // The ui:state subscription + ui-connected handshake are owned by App.svelte.
  onMount(() => {
    const notificationService = new AgentNotificationService();
    return setupDomainEventBindings(notificationService);
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

  // Open the settings dialog (sidebar gear). Main forwards this to the settings
  // module, which opens the declarative settings dialog.
  function handleOpenSettings(): void {
    api.emitEvent({ kind: "open-settings" });
  }
</script>

<div class="main-view">
  <WorkspaceFrames frames={frameEntries} activeKey={activeFrameKey} {mode} />
  <Sidebar
    projects={projectRows}
    sidebarWidth={ui.sidebar.width}
    notifications={ui.notifications}
    {mode}
    labelScroll={ui.labelScroll}
    shortcutModeActive={mode === "shortcut"}
    capturing={ui.capturing}
    newWorkspaceViewOpen={creationShown}
    onCloseProject={handleCloseProject}
    onSwitchWorkspace={handleSwitchWorkspace}
    onOpenNewWorkspace={handleOpenNewWorkspace}
    onRemoveWorkspace={handleRemoveWorkspace}
    onOpenSettings={handleOpenSettings}
  />

  <ShortcutOverlay
    active={mode === "shortcut"}
    workspaceCount={totalWorkspaces}
    hasActiveWorkspace={activeRow !== null}
    activeHibernated={main?.kind === "hibernated"}
    activeWorkspaceDeletionInProgress={activeRow !== null && activeRow.status === "deleting"}
    {idleWorkspaceCount}
  />

  <!-- Creation panel ("modeless"): the backend creation module's always-alive
       form session, a popup ABOVE the sidebar, shown while the snapshot's main
       view is "creation" (the ground state when no workspace is active). -->
  {#if creationShown && creationDialog}
    <PanelView
      dialogId={creationDialog.id}
      config={creationDialog.config}
      kind="modeless"
      {modalAbove}
    />
  {/if}

  <!-- Deletion panel ("panel"): the deletion module's progress/failed session,
       shown in place of the active workspace's (already torn-down) view, BELOW
       the sidebar so the sidebar stays on top and navigable. The module opens
       it only while its workspace is the active one, so it never coexists with
       the creation ground state. -->
  {#if main?.kind === "workspace" && deletionDialog}
    <PanelView
      dialogId={deletionDialog.id}
      config={deletionDialog.config}
      kind="panel"
      {modalAbove}
    />
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
