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
  import StartupView from "./StartupView.svelte";

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
   * The active panel-surface dialog session (the creation form is the only one
   * today). View-only pick over the snapshot's dialogs; if several are open the
   * most recently opened wins (snapshot order).
   */
  const panelDialog = $derived(ui.dialogs.filter((d) => d.surface === "panel").at(-1));
  /** Whether any modal dialog is open above the panel (drives panel refocus). */
  const modalAbove = $derived(ui.dialogs.some((d) => d.surface === "modal"));
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

  // The mid-session "Loading workspace…" surface: the active workspace is still
  // being created, so it has no frame yet. App keeps MainView mounted through
  // this state (rather than swapping in StartupView) so the OTHER workspaces'
  // iframes are not torn down and reloaded; we show the loading screen as an
  // overlay over the kept-alive frames, reusing StartupView's loading visual.
  const loadingMain = $derived(main?.kind === "loading" ? main : null);

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
    const session = panelDialog;
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
</script>

<div class="main-view">
  <WorkspaceFrames frames={frameEntries} activeKey={activeFrameKey} {mode} />
  <Sidebar
    projects={projectRows}
    notifications={ui.notifications}
    {mode}
    shortcutModeActive={mode === "shortcut"}
    capturing={ui.capturing}
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
  {#if creationShown && panelDialog}
    <PanelView dialogId={panelDialog.id} config={panelDialog.config} {modalAbove} />
  {/if}

  {#if main?.kind === "hibernated"}
    <HibernatedOverlay screenshot={main.screenshot} onWake={handleWakeActiveWorkspace} />
  {/if}

  <!-- Mid-session loading (still-creating active workspace): overlay the
       workspace area, leaving the kept-alive frames mounted underneath so
       creating a workspace never reloads the others. -->
  {#if loadingMain}
    <StartupView main={loadingMain} workspaceArea={true} />
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
