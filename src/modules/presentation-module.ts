/**
 * PresentationModule - the UI presenter (Phases A+B of
 * planning/UI_STATE_ARCHITECTURE.md).
 *
 * Owns both UI wires of the target architecture:
 *
 * - api:ui:event (renderer → main): zod-validated intake. `log` is the
 *   renderer's logging channel; `remove-workspace` and `close-project` are
 *   load-bearing requests — the presenter resolves their snapshot identity
 *   (key / projectId) against its model and dispatches the matching intent
 *   with `interactive: true`, fire-and-forget (parking and failure surfacing
 *   are the operations' business). The remaining events are observational
 *   for now.
 * - api:ui:state (main → renderer): full UiState snapshots rebuilt from
 *   domain events and pushed coalesced per microtask.
 *
 * Also registers the "confirm" hook on project:close — the close
 * confirmation dialog (the presenter's first dialog ownership; the remove
 * confirm lives with the rest of the deletion flow in deletion-dialog-module).
 *
 * The view-model mirrors today's renderer store semantics (projects store,
 * creating placeholders, deletion lifecycle, agent status, active workspace,
 * theme). The creation panel is derived, not tracked: it is the main view's
 * ground state whenever no workspace is active. Workspace keys are
 * presenter-assigned and opaque to the renderer. Pushing starts at the
 * app:started event, which fires after the initial project:open dispatches
 * complete.
 */

import type { IntentModule, EventDeclarations } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { HookContext } from "../intents/lib/operation";
import type { IDispatcher } from "../intents/lib/dispatcher";
import type { IpcBoundary, IpcEventHandler } from "../boundaries/shell/ipc";
import type { Logging, LoggerName, LogContext } from "../boundaries/platform/logging";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import type { PathProvider } from "../boundaries/platform/path-provider";
import type { IViewManager } from "../boundaries/shell/view-manager.interface";
import type { Theme } from "../boundaries/shell/window-manager";
import type { Unsubscribe } from "../shared/api/interfaces";
import type { AgentStatus, DeletionProgress, WorkspaceTag } from "../shared/api/types";
import { extractTags, TAGS_METADATA_KEY_PREFIX } from "../shared/api/types";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import { EVENT_APP_STARTED, INTENT_APP_READY, type AppReadyIntent } from "../intents/app-ready";
import { EVENT_PROJECT_OPENED, type ProjectOpenedEvent } from "../intents/open-project";
import {
  EVENT_PROJECT_CLOSED,
  INTENT_CLOSE_PROJECT,
  CLOSE_PROJECT_OPERATION_ID,
  type ProjectClosedEvent,
  type CloseProjectIntent,
  type CloseConfirmHookInput,
  type CloseConfirmHookResult,
} from "../intents/close-project";
import {
  EVENT_WORKSPACE_CREATED,
  EVENT_WORKSPACE_LOADING,
  EVENT_WORKSPACE_CREATE_FAILED,
  type WorkspaceCreatedEvent,
  type WorkspaceLoadingEvent,
  type WorkspaceCreateFailedEvent,
} from "../intents/open-workspace";
import {
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETION_PROGRESS,
  INTENT_DELETE_WORKSPACE,
  type DeleteWorkspaceIntent,
  type WorkspaceDeletedEvent,
  type WorkspaceDeletionProgressEvent,
} from "../intents/delete-workspace";
import {
  EVENT_WORKSPACE_SWITCHED,
  INTENT_SWITCH_WORKSPACE,
  type WorkspaceSwitchedEvent,
  type SwitchWorkspaceIntent,
} from "../intents/switch-workspace";
import {
  EVENT_AGENT_STATUS_UPDATED,
  type AgentStatusUpdatedEvent,
} from "../intents/update-agent-status";
import { EVENT_METADATA_CHANGED, type MetadataChangedEvent } from "../intents/set-metadata";
import {
  EVENT_SHORTCUT_ACTIVE_CHANGED,
  type ShortcutActiveChangedEvent,
} from "../intents/set-shortcut-active";
import { EVENT_SHORTCUT_KEY_PRESSED, type ShortcutKeyPressedEvent } from "../intents/shortcut-key";
import {
  INTENT_HIBERNATE_WORKSPACE,
  type HibernateWorkspaceIntent,
} from "../intents/hibernate-workspace";
import { INTENT_WAKE_WORKSPACE, type WakeWorkspaceIntent } from "../intents/wake-workspace";
import { isShortcutKey, jumpKeyToIndex, type JumpKey } from "../shared/shortcuts";
import type { UIMode } from "../shared/ipc";
import { ApiIpcChannels } from "../shared/ipc";
import type { DialogConfig, DialogSection } from "../shared/dialog-types";
import { uiEventSchema } from "../shared/ui-event";
import {
  compareDisplayNames,
  type UiMainView,
  type UiProjectRow,
  type UiState,
  type UiWorkspaceRow,
} from "../shared/ui-state";
import { buildScreenshotPath } from "./hibernation-screenshot-module";
import type { DialogManager } from "./dialog-manager";
import type { NotificationManager } from "./notification-manager";
import { getErrorMessage } from "../shared/error-utils";

export interface PresentationModuleDeps {
  readonly ipcLayer: Pick<IpcBoundary, "on" | "removeListener">;
  readonly loggingService: Pick<Logging, "createLogger">;
  readonly viewManager: Pick<IViewManager, "sendToUI">;
  readonly windowManager: {
    getTheme(): Theme;
    onThemeChange(callback: (theme: Theme) => void): Unsubscribe;
  };
  readonly fileSystem: Pick<FileSystemBoundary, "readFileBuffer">;
  readonly pathProvider: PathProvider;
  readonly dialogManager: Pick<DialogManager, "open" | "isModalOpen" | "onModalOpenChange">;
  readonly dispatcher: Pick<IDispatcher, "dispatch">;
  readonly notificationManager: Pick<NotificationManager, "markUIReady">;
}

/**
 * Validate and convert logger name from renderer to LoggerName type.
 * Returns "ui" if the provided name is not a valid renderer logger name.
 */
const VALID_RENDERER_LOGGER_NAMES = new Set<string>(["ui", "api"]);
function toLoggerName(name: string): LoggerName {
  return VALID_RENDERER_LOGGER_NAMES.has(name) ? (name as LoggerName) : "ui";
}

// =============================================================================
// Internal view-model
// =============================================================================

/**
 * Semantic workspace view-model. The UI cares about meanings, not metadata:
 * domain metadata is interpreted once at event intake (hibernated flag,
 * tags) and raw metadata is never stored.
 */
interface WorkspaceModel {
  readonly name: string;
  /** Real worktree path; null while the workspace is still being created. */
  path: string | null;
  hibernated: boolean;
  tags: WorkspaceTag[];
  url: string | undefined;
  creating: boolean;
}

/** Interpret a workspace's domain metadata into the semantic model fields. */
function fromMetadata(
  metadata: Readonly<Record<string, string>>
): Pick<WorkspaceModel, "hibernated" | "tags"> {
  return {
    hibernated: metadata["hibernated"] === "true",
    tags: extractTags(metadata),
  };
}

interface ProjectModel {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly remoteUrl: string | undefined;
  /** Keyed by workspace name (unique per project); insertion-ordered. */
  readonly workspaces: Map<string, WorkspaceModel>;
}

const AGENT_NONE: AgentStatus = { type: "none" };

// =============================================================================
// Close-project confirmation dialog
// =============================================================================

/** User-driven state of the close-project confirmation dialog. */
interface CloseConfirmState {
  removeAll: boolean;
  keepRepo: boolean;
}

/**
 * Build the close confirmation DialogConfig. Remote projects delete the
 * cloned repository by default ("Keep cloned repository" unchecked), which
 * implies removing all workspaces — the remove-all checkbox is then forced
 * checked and disabled. Both checkboxes opt into change events and the
 * backend echoes its model on every update (the checkbox adopt-once
 * contract).
 */
function buildCloseConfirmConfig(
  state: CloseConfirmState,
  workspaceCount: number,
  remoteUrl: string | undefined
): DialogConfig {
  const isRemote = remoteUrl !== undefined;
  const shouldDeleteRepo = isRemote && !state.keepRepo;
  const removeAll = state.removeAll || shouldDeleteRepo;

  const sections: DialogSection[] = [{ type: "text", content: "Close Project", style: "heading" }];

  if (workspaceCount > 0) {
    const workspaceText = workspaceCount === 1 ? "1 workspace" : `${workspaceCount} workspaces`;
    sections.push({
      type: "text",
      content: `This project has ${workspaceText} that will remain on disk after closing.`,
    });
    sections.push({
      type: "checkbox",
      id: "remove-all",
      label: "Remove all workspaces and their branches",
      value: removeAll,
      disabled: shouldDeleteRepo,
      changeEvent: true,
    });
  }

  if (isRemote) {
    sections.push({
      type: "checkbox",
      id: "keep-repo",
      label: "Keep cloned repository",
      value: state.keepRepo,
      changeEvent: true,
    });
    if (shouldDeleteRepo) {
      sections.push({
        type: "text",
        content:
          "This will permanently delete the cloned repository and all workspaces, " +
          `including any uncommitted changes. You can clone it again from: ${remoteUrl}`,
        style: "warning",
      });
    }
  }

  if (!shouldDeleteRepo && removeAll && workspaceCount > 0) {
    sections.push({
      type: "text",
      content:
        "All workspaces and their branches will be removed, including any uncommitted changes.",
      style: "warning",
    });
  }

  const closeLabel = shouldDeleteRepo
    ? "Delete & Close"
    : removeAll
      ? "Remove & Close"
      : "Close Project";
  sections.push({
    type: "group",
    items: [
      { type: "button", id: "close", label: closeLabel, variant: "primary" },
      // role "cancel": Escape clicks this button (mirrors Cancel). The form
      // auto-focuses the first field (a checkbox) or the primary button.
      { type: "button", id: "cancel", label: "Cancel", variant: "secondary", role: "cancel" },
    ],
  });

  return { sections, modal: true };
}

export function createPresentationModule(deps: PresentationModuleDeps): IntentModule {
  const logger = deps.loggingService.createLogger("presenter");

  // ---------------------------------------------------------------------------
  // State (mirrors the renderer stores' semantics)
  // ---------------------------------------------------------------------------

  /** Keyed by projectId; insertion-ordered. */
  const projects = new Map<string, ProjectModel>();
  /** Agent status keyed by workspace path. */
  const agentStatuses = new Map<string, AgentStatus>();
  /** Deletion lifecycle keyed by workspace path (absent = not deleting). */
  const deletions = new Map<string, { failed: boolean }>();
  /** Hibernation screenshot data URLs keyed by workspace key (null = missing). */
  const screenshots = new Map<string, string | null>();
  const screenshotLoads = new Set<string>();
  let activeKey: string | null = null;
  let theme: Theme = "dark";
  let started = false;
  let pushScheduled = false;
  let themeUnsubscribe: Unsubscribe | null = null;

  // --- UI mode inputs (main-owned). Mode = shortcut > dialog > hover >
  //     workspace, computed in buildMode() from these four signals.
  /** Alt+X shortcut mode active (owned by shortcut-module, signalled here). */
  let shortcutActive = false;
  /** A modal-surface dialog is open (queried + subscribed from dialog-manager). */
  let dialogModalOpen = deps.dialogManager.isModalOpen();
  /** Last settled hover region from the renderer's `hover` ui:event. */
  let hoverRegion: "sidebar" | null = null;
  const modalUnsubscribe = deps.dialogManager.onModalOpenChange((open) => {
    dialogModalOpen = open;
    scheduleUpdate();
  });

  /** Presenter-assigned opaque workspace identity. Never leaves main except inside UiState. */
  function workspaceKey(projectId: string, workspaceName: string): string {
    return `${projectId}/${workspaceName}`;
  }

  function findProjectByPath(projectPath: string): ProjectModel | undefined {
    for (const project of projects.values()) {
      if (project.path === projectPath) return project;
    }
    return undefined;
  }

  function findByKey(
    key: string
  ): { project: ProjectModel; workspace: WorkspaceModel } | undefined {
    for (const project of projects.values()) {
      for (const workspace of project.workspaces.values()) {
        if (workspaceKey(project.id, workspace.name) === key) return { project, workspace };
      }
    }
    return undefined;
  }

  /**
   * Set the active workspace, removing a creating placeholder when switching
   * away from it (mirrors the renderer's applyActiveWorkspace).
   */
  function applyActiveKey(next: string | null): void {
    if (activeKey !== null && activeKey !== next) {
      const current = findByKey(activeKey);
      if (current?.workspace.creating) {
        current.project.workspaces.delete(current.workspace.name);
      }
    }
    activeKey = next;
  }

  // ---------------------------------------------------------------------------
  // Snapshot building + push
  // ---------------------------------------------------------------------------

  function rowStatus(workspace: WorkspaceModel): UiWorkspaceRow["status"] {
    if (workspace.creating) return "creating";
    const deletion = workspace.path === null ? undefined : deletions.get(workspace.path);
    if (deletion) return deletion.failed ? "delete-failed" : "deleting";
    return "ready";
  }

  /**
   * Resolve the hibernation screenshot for the active workspace. Reads are
   * async: the first snapshot carries null and a re-push follows once the
   * PNG is loaded (or confirmed missing).
   */
  function resolveScreenshot(
    key: string,
    project: ProjectModel,
    workspace: WorkspaceModel
  ): string | null {
    const cached = screenshots.get(key);
    if (cached !== undefined) return cached;
    if (!screenshotLoads.has(key)) {
      screenshotLoads.add(key);
      const filePath = buildScreenshotPath(deps.pathProvider, project.id, workspace.name);
      deps.fileSystem
        .readFileBuffer(filePath)
        .then((png) => {
          screenshots.set(key, `data:image/png;base64,${png.toString("base64")}`);
        })
        .catch(() => {
          screenshots.set(key, null);
        })
        .finally(() => {
          screenshotLoads.delete(key);
          scheduleUpdate();
        });
    }
    return null;
  }

  /**
   * Build a UiWorkspaceRow for a workspace in a project (single source of
   * truth for both the snapshot and shortcut navigation, so they always agree
   * on ordering and status).
   */
  function buildRow(project: ProjectModel, workspace: WorkspaceModel): UiWorkspaceRow {
    const key = workspaceKey(project.id, workspace.name);
    return {
      key,
      name: workspace.name,
      status: rowStatus(workspace),
      hibernated: workspace.hibernated,
      agent:
        (workspace.path === null ? undefined : agentStatuses.get(workspace.path)) ?? AGENT_NONE,
      // Copy: the model array mutates on tag changes; snapshots are immutable values.
      tags: [...workspace.tags],
      active: key === activeKey,
    };
  }

  /** A workspace row plus the model objects it was built from. */
  interface RowEntry {
    readonly row: UiWorkspaceRow;
    readonly project: ProjectModel;
    readonly workspace: WorkspaceModel;
  }

  /**
   * All workspace rows in sidebar display order — the authoritative ordering
   * shared by the snapshot (buildSnapshot) and shortcut navigation. Projects
   * and workspaces sort by display name (AaBbCc).
   */
  function currentRows(): RowEntry[] {
    const entries: RowEntry[] = [];
    for (const project of [...projects.values()].sort((a, b) =>
      compareDisplayNames(a.name, b.name)
    )) {
      for (const workspace of [...project.workspaces.values()].sort((a, b) =>
        compareDisplayNames(a.name, b.name)
      )) {
        entries.push({ row: buildRow(project, workspace), project, workspace });
      }
    }
    return entries;
  }

  function buildMain(): UiMainView {
    // The creation panel is the ground state: shown whenever nothing is
    // active (including a stale activeKey whose workspace is gone).
    if (activeKey === null) return { kind: "creation" };
    const active = findByKey(activeKey);
    if (!active) return { kind: "creation" };
    if (active.workspace.hibernated) {
      return {
        kind: "hibernated",
        screenshot: resolveScreenshot(activeKey, active.project, active.workspace),
      };
    }
    return { kind: "workspace", frameKey: activeKey };
  }

  /**
   * Compute the single UI mode. Priority shortcut > dialog > hover > workspace.
   * The creation panel (no active workspace) maps to hover-level: UI on top but
   * Alt+X still works.
   */
  function buildMode(main: UiMainView): UIMode {
    if (shortcutActive) return "shortcut";
    if (dialogModalOpen) return "dialog";
    if (main.kind === "creation" || hoverRegion === "sidebar") return "hover";
    return "workspace";
  }

  function buildSnapshot(): UiState {
    const projectRows: UiProjectRow[] = [...projects.values()]
      .sort((a, b) => compareDisplayNames(a.name, b.name))
      .map((project) => ({
        id: project.id,
        name: project.name,
        title: project.remoteUrl ?? project.path,
        remote: project.remoteUrl !== undefined,
        workspaces: [...project.workspaces.values()]
          .sort((a, b) => compareDisplayNames(a.name, b.name))
          .map((workspace): UiWorkspaceRow => buildRow(project, workspace)),
      }));

    const frames: Record<string, string> = {};
    for (const project of projects.values()) {
      for (const workspace of project.workspaces.values()) {
        if (workspace.url !== undefined && !workspace.hibernated) {
          frames[workspaceKey(project.id, workspace.name)] = workspace.url;
        }
      }
    }

    const main = buildMain();
    return { sidebar: { projects: projectRows }, frames, main, theme, mode: buildMode(main) };
  }

  function scheduleUpdate(): void {
    if (!started || pushScheduled) return;
    pushScheduled = true;
    queueMicrotask(() => {
      pushScheduled = false;
      push();
    });
  }

  function push(): void {
    const snapshot = buildSnapshot();
    deps.viewManager.sendToUI(ApiIpcChannels.UI_STATE, snapshot);
    logger.debug("ui:state push", { snapshot: JSON.stringify(snapshot) });
  }

  // ---------------------------------------------------------------------------
  // ui:event intake (renderer → main)
  // ---------------------------------------------------------------------------

  /** Dispatch fire-and-forget: the intake must never await a parked confirm. */
  function dispatchDetached(
    intent:
      | DeleteWorkspaceIntent
      | CloseProjectIntent
      | SwitchWorkspaceIntent
      | HibernateWorkspaceIntent
      | WakeWorkspaceIntent
  ): void {
    const handle = deps.dispatcher.dispatch(intent);
    void handle.catch((error: unknown) => {
      logger.debug("ui-event dispatch rejected", {
        intent: intent.type,
        error: getErrorMessage(error),
      });
    });
  }

  /** The interactive remove flow (shared by the ui:event and shortcut delete). */
  function dispatchInteractiveDelete(workspacePath: string): void {
    dispatchDetached({
      type: INTENT_DELETE_WORKSPACE,
      payload: {
        workspacePath,
        keepBranch: false,
        force: false,
        removeWorktree: true,
        interactive: true,
      },
    });
  }

  const listener: IpcEventHandler = (_event: unknown, ...args: unknown[]) => {
    const result = uiEventSchema.safeParse(args[0]);
    if (!result.success) {
      logger.warn("Dropped invalid ui event", {
        issue: result.error.issues[0]?.message ?? "unknown",
      });
      return;
    }
    const event = result.data;
    if (event.kind === "ui-connected") {
      // Startup handshake: the renderer has mounted and subscribed to ui:state.
      // Flush buffered notifications and kick app:ready (load projects →
      // app:started → opens the snapshot stream). Fire-and-forget: the genesis
      // snapshot flows back on ui:state, the renderer awaits nothing.
      deps.notificationManager.markUIReady();
      const handle = deps.dispatcher.dispatch({
        type: INTENT_APP_READY,
        payload: {},
      } as AppReadyIntent);
      void handle.catch((error: unknown) => {
        logger.debug("app:ready dispatch rejected", { error: getErrorMessage(error) });
      });
      return;
    }
    if (event.kind === "log") {
      try {
        const target = deps.loggingService.createLogger(toLoggerName(event.logger));
        target[event.level](event.message, event.context as LogContext | undefined);
      } catch {
        // Swallow errors - logging should never crash the app
      }
      return;
    }
    if (event.kind === "remove-workspace") {
      // Resolve the echoed snapshot key against the model; a stale key (the
      // workspace vanished since the snapshot) is dropped, like stale
      // metadata. Placeholders (path null) have nothing to delete yet.
      const found = findByKey(event.key);
      if (!found || found.workspace.path === null) {
        logger.warn("Dropped remove-workspace for unknown key", { key: event.key });
        return;
      }
      dispatchInteractiveDelete(found.workspace.path);
      return;
    }
    if (event.kind === "switch-workspace") {
      // key null = deselect (the creation panel becomes the main view).
      if (event.key === null) {
        dispatchDetached({ type: INTENT_SWITCH_WORKSPACE, payload: { workspacePath: null } });
        return;
      }
      // Resolve the echoed key; a stale key or still-creating placeholder
      // (path null) has nothing to switch to. focus is omitted: a click
      // focuses the workspace (the keyboard nav path passes focus:false).
      const found = findByKey(event.key);
      if (!found || found.workspace.path === null) {
        logger.warn("Dropped switch-workspace for unknown key", { key: event.key });
        return;
      }
      dispatchDetached({
        type: INTENT_SWITCH_WORKSPACE,
        payload: { workspacePath: found.workspace.path },
      });
      return;
    }
    if (event.kind === "wake-workspace") {
      const found = findByKey(event.key);
      if (!found || found.workspace.path === null) {
        logger.warn("Dropped wake-workspace for unknown key", { key: event.key });
        return;
      }
      dispatchDetached({
        type: INTENT_WAKE_WORKSPACE,
        payload: { workspacePath: found.workspace.path, source: "ui-ipc" },
      });
      return;
    }
    if (event.kind === "hover") {
      hoverRegion = event.region === "sidebar" ? "sidebar" : null;
      scheduleUpdate();
      return;
    }
    // close-project: the only remaining kind.
    const project = projects.get(event.projectId);
    if (!project) {
      logger.warn("Dropped close-project for unknown project", { projectId: event.projectId });
      return;
    }
    dispatchDetached({
      type: INTENT_CLOSE_PROJECT,
      payload: { projectPath: project.path, interactive: true },
    });
  };

  deps.ipcLayer.on(ApiIpcChannels.UI_EVENT, listener);

  // ---------------------------------------------------------------------------
  // Shortcut navigation (ported from the renderer's shortcuts store)
  //
  // The shortcut-module forwards every key press while shortcut mode is active
  // as a shortcut:key intent → shortcut:key-pressed event. The presenter runs
  // navigation over the SAME ordered rows it renders (currentRows()), and
  // dispatches the existing intents directly with focus:false (so shortcut mode
  // stays active across keyboard navigation).
  // ---------------------------------------------------------------------------

  /** Wrap an index into [0, length). */
  function wrapIndex(index: number, length: number): number {
    return ((index % length) + length) % length;
  }

  /** Switch to a workspace by its real path (placeholders are skipped upstream). */
  function navigateSwitch(workspacePath: string): void {
    dispatchDetached({
      type: INTENT_SWITCH_WORKSPACE,
      payload: { workspacePath, focus: false },
    });
  }

  /**
   * Up/down navigation. Wraps at boundaries; when nothing is active (creation
   * panel) Up → last and Down → first. Targets the workspace's real path; a
   * still-creating placeholder (null path) is not a valid target.
   */
  function handleNavigation(direction: -1 | 1): void {
    const entries = currentRows();
    if (entries.length === 0) return;
    const currentIndex = entries.findIndex((e) => e.row.active);
    const nextIndex =
      currentIndex === -1
        ? direction === 1
          ? 0
          : entries.length - 1
        : wrapIndex(currentIndex + direction, entries.length);
    if (nextIndex === currentIndex) return;
    const target = entries[nextIndex];
    if (!target || target.workspace.path === null) return;
    navigateSwitch(target.workspace.path);
  }

  /**
   * Find the next workspace index matching a status type in the given
   * direction. Hibernated workspaces are always skipped — idle nav targets
   * workspaces the user can immediately work in. Returns -1 if none.
   */
  function findNextByStatusType(
    entries: readonly RowEntry[],
    currentIndex: number,
    direction: -1 | 1,
    statusType: AgentStatus["type"]
  ): number {
    const count = entries.length;
    const startIndex =
      currentIndex === -1
        ? direction === 1
          ? 0
          : count - 1
        : wrapIndex(currentIndex + direction, count);
    const iterations = currentIndex === -1 ? count : count - 1;
    for (let i = 0; i < iterations; i++) {
      const index = wrapIndex(startIndex + i * direction, count);
      const entry = entries[index];
      if (!entry) continue;
      if (entry.row.hibernated) continue;
      if (entry.row.agent.type === statusType) return index;
    }
    return -1;
  }

  /**
   * Left/right navigation by status: prefer idle workspaces, fall back to busy
   * only when the current workspace isn't already idle (or there is none).
   */
  function handleStatusNavigation(direction: -1 | 1): void {
    const entries = currentRows();
    if (entries.length === 0) return;
    const currentIndex = entries.findIndex((e) => e.row.active);

    let targetIndex = findNextByStatusType(entries, currentIndex, direction, "idle");
    if (targetIndex === -1) {
      const currentStatus = currentIndex === -1 ? undefined : entries[currentIndex]?.row.agent;
      if (currentStatus?.type !== "idle") {
        targetIndex = findNextByStatusType(entries, currentIndex, direction, "busy");
      }
    }
    if (targetIndex === -1) return;
    const target = entries[targetIndex];
    if (!target || target.workspace.path === null) return;
    navigateSwitch(target.workspace.path);
  }

  /** Jump to the Nth awake workspace (hibernated workspaces are unnumbered). */
  function handleJump(key: JumpKey): void {
    const index = jumpKeyToIndex(key);
    const target = currentRows().filter((e) => !e.row.hibernated)[index];
    if (!target || target.workspace.path === null) return;
    navigateSwitch(target.workspace.path);
  }

  /** Toggle hibernation on the active workspace (h key). */
  function handleHibernateToggle(): void {
    if (activeKey === null) return;
    const active = findByKey(activeKey);
    if (!active || active.workspace.path === null) return;
    if (active.workspace.hibernated) {
      dispatchDetached({
        type: INTENT_WAKE_WORKSPACE,
        payload: { workspacePath: active.workspace.path, source: "ui-ipc" },
      });
    } else {
      dispatchDetached({
        type: INTENT_HIBERNATE_WORKSPACE,
        payload: { workspacePath: active.workspace.path },
      });
    }
  }

  /**
   * Enter / Delete dialog keys.
   * - enter: deselect (switch to null) so the creation panel becomes the main
   *   view — unless it is already showing. Mode auto-computes to hover.
   * - delete: trigger the interactive remove flow for the active workspace
   *   (the same path the remove-workspace ui:event uses), unless it is still
   *   creating or already deleting.
   */
  function handleDialogKey(key: "enter" | "delete"): void {
    if (key === "enter") {
      if (activeKey === null) return; // creation panel already showing
      dispatchDetached({
        type: INTENT_SWITCH_WORKSPACE,
        payload: { workspacePath: null },
      });
      return;
    }
    if (activeKey === null) return;
    const active = findByKey(activeKey);
    if (!active || active.workspace.path === null) return;
    const status = rowStatus(active.workspace);
    if (status === "creating" || status === "deleting") return;
    dispatchInteractiveDelete(active.workspace.path);
  }

  /** Run the navigation action for a normalized shortcut key. */
  function runShortcutKey(key: string): void {
    switch (key) {
      case "up":
        handleNavigation(-1);
        break;
      case "down":
        handleNavigation(1);
        break;
      case "left":
        handleStatusNavigation(-1);
        break;
      case "right":
        handleStatusNavigation(1);
        break;
      case "enter":
        handleDialogKey("enter");
        break;
      case "delete":
        handleDialogKey("delete");
        break;
      case "h":
        handleHibernateToggle();
        break;
      default:
        if (/^[0-9]$/.test(key)) handleJump(key as JumpKey);
    }
  }

  // ---------------------------------------------------------------------------
  // Domain event subscriptions (main → view-model)
  // ---------------------------------------------------------------------------

  const events: EventDeclarations = {
    [EVENT_PROJECT_OPENED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const { project } = (event as ProjectOpenedEvent).payload;
        if (findProjectByPath(project.path)) return;
        projects.set(project.id, {
          id: project.id,
          name: project.name,
          path: project.path,
          remoteUrl: project.remoteUrl,
          workspaces: new Map(
            project.workspaces.map((workspace) => [
              workspace.name as string,
              {
                name: workspace.name,
                path: workspace.path,
                ...fromMetadata(workspace.metadata),
                url: workspace.url,
                creating: false,
              },
            ])
          ),
        });
        scheduleUpdate();
      },
    },
    [EVENT_PROJECT_CLOSED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const { projectId } = (event as ProjectClosedEvent).payload;
        const project = projects.get(projectId);
        if (!project) return;
        const containedActive =
          activeKey !== null &&
          [...project.workspaces.values()].some(
            (workspace) => workspaceKey(project.id, workspace.name) === activeKey
          );
        projects.delete(projectId);
        if (containedActive) {
          // Mirror the renderer's fallback: first workspace of the first
          // remaining project (insertion order), else none.
          const firstProject = projects.values().next().value;
          const firstWorkspace = firstProject?.workspaces.values().next().value;
          activeKey =
            firstProject && firstWorkspace
              ? workspaceKey(firstProject.id, firstWorkspace.name)
              : null;
        }
        scheduleUpdate();
      },
    },
    [EVENT_WORKSPACE_CREATED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const p = (event as WorkspaceCreatedEvent).payload;
        const project = projects.get(p.projectId);
        if (project) {
          // Setting by name replaces a creating placeholder in place.
          project.workspaces.set(p.workspaceName as string, {
            name: p.workspaceName,
            path: p.workspacePath,
            ...fromMetadata(p.metadata),
            url: p.workspaceUrl,
            creating: false,
          });
          // A wake delivers a fresh URL; any cached screenshot is stale.
          screenshots.delete(workspaceKey(p.projectId, p.workspaceName));
        }
        if (p.stealFocus !== false) {
          applyActiveKey(workspaceKey(p.projectId, p.workspaceName));
        }
        scheduleUpdate();
      },
    },
    [EVENT_WORKSPACE_LOADING]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const p = (event as WorkspaceLoadingEvent).payload;
        const project = findProjectByPath(p.projectPath);
        if (!project) return;
        // Name-guarded: loading also fires for wakes/reopens of existing
        // workspaces, which must not create a duplicate entry.
        const nameLower = p.workspaceName.toLowerCase();
        for (const workspace of project.workspaces.values()) {
          if (workspace.name.toLowerCase() === nameLower) return;
        }
        project.workspaces.set(p.workspaceName, {
          name: p.workspaceName,
          path: null,
          hibernated: false,
          tags: [],
          url: undefined,
          creating: true,
        });
        // Landing in the creating placeholder is the visual confirmation the
        // workspace is being made (activating it also leaves the creation
        // panel, which only shows while nothing is active).
        activeKey = workspaceKey(project.id, p.workspaceName);
        scheduleUpdate();
      },
    },
    [EVENT_WORKSPACE_CREATE_FAILED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const p = (event as WorkspaceCreateFailedEvent).payload;
        const project = findProjectByPath(p.projectPath);
        const workspace = project?.workspaces.get(p.workspaceName);
        if (!project || !workspace?.creating) return;
        project.workspaces.delete(p.workspaceName);
        if (activeKey === workspaceKey(project.id, p.workspaceName)) {
          activeKey = null;
        }
        scheduleUpdate();
      },
    },
    [EVENT_WORKSPACE_DELETED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const p = (event as WorkspaceDeletedEvent).payload;
        projects.get(p.projectId)?.workspaces.delete(p.workspaceName as string);
        deletions.delete(p.workspacePath);
        agentStatuses.delete(p.workspacePath);
        screenshots.delete(workspaceKey(p.projectId, p.workspaceName));
        scheduleUpdate();
      },
    },
    [EVENT_WORKSPACE_DELETION_PROGRESS]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const progress = (event as WorkspaceDeletionProgressEvent).payload as DeletionProgress;
        if (progress.completed && !progress.hasErrors) {
          // Auto-clear on successful completion (workspace:deleted removes the row).
          deletions.delete(progress.workspacePath);
        } else {
          deletions.set(progress.workspacePath, {
            failed: progress.completed && progress.hasErrors,
          });
        }
        scheduleUpdate();
      },
    },
    [EVENT_WORKSPACE_SWITCHED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const payload = (event as WorkspaceSwitchedEvent).payload;
        applyActiveKey(payload ? workspaceKey(payload.projectId, payload.workspaceName) : null);
        scheduleUpdate();
      },
    },
    [EVENT_AGENT_STATUS_UPDATED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const { workspace, status } = (event as AgentStatusUpdatedEvent).payload;
        agentStatuses.set(
          workspace.path,
          status.status === "none"
            ? AGENT_NONE
            : {
                type: status.status,
                counts: {
                  idle: status.counts.idle,
                  busy: status.counts.busy,
                  total: status.counts.idle + status.counts.busy,
                },
              }
        );
        scheduleUpdate();
      },
    },
    [EVENT_METADATA_CHANGED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const p = (event as MetadataChangedEvent).payload;
        const workspace = projects.get(p.projectId)?.workspaces.get(p.workspaceName as string);
        if (!workspace) return;
        // Metadata is interpreted, never stored: only the keys the UI cares
        // about mutate the model (and push); everything else is ignored.
        if (p.key === "hibernated") {
          workspace.hibernated = p.value === "true";
          // Flag flips invalidate the cached screenshot (deleted on wake).
          screenshots.delete(workspaceKey(p.projectId, p.workspaceName));
        } else if (p.key.startsWith(TAGS_METADATA_KEY_PREFIX)) {
          const name = p.key.slice(TAGS_METADATA_KEY_PREFIX.length);
          workspace.tags = workspace.tags.filter((tag) => tag.name !== name);
          if (p.value !== null) {
            // extractTags owns the parsing (color JSON, empty-name guard).
            workspace.tags.push(...extractTags({ [p.key]: p.value }));
          }
        } else {
          return;
        }
        scheduleUpdate();
      },
    },
    [EVENT_APP_STARTED]: {
      handler: async (): Promise<void> => {
        started = true;
        theme = deps.windowManager.getTheme();
        themeUnsubscribe = deps.windowManager.onThemeChange((next) => {
          theme = next;
          scheduleUpdate();
        });
        scheduleUpdate();
      },
    },
    [EVENT_SHORTCUT_ACTIVE_CHANGED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        shortcutActive = (event as ShortcutActiveChangedEvent).payload.active;
        scheduleUpdate();
      },
    },
    [EVENT_SHORTCUT_KEY_PRESSED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const { key } = (event as ShortcutKeyPressedEvent).payload;
        // Only navigation runs in shortcut mode; the shortcut-module already
        // handles Escape/Alt-release. Validate the key like the old IPC bridge.
        if (isShortcutKey(key)) runShortcutKey(key);
      },
    },
  };

  /**
   * The "confirm" hook on project:close (interactive dispatches only): parks
   * the dispatch on the close confirmation dialog. Checkbox changes round-trip
   * through the backend model (interlock: keeping the cloned repository
   * unchecks remove-all; deleting it forces remove-all on).
   */
  async function confirmClose(ctx: HookContext): Promise<CloseConfirmHookResult> {
    const input = ctx as CloseConfirmHookInput;
    const isRemote = input.remoteUrl !== undefined;
    const state: CloseConfirmState = { removeAll: false, keepRepo: false };
    const buildConfig = (): DialogConfig =>
      buildCloseConfirmConfig(state, input.workspaces.length, input.remoteUrl);

    const handle = deps.dialogManager.open(buildConfig());
    const unsubscribe = handle.onChange((change) => {
      if (change.fieldId === "remove-all") {
        state.removeAll = change.data["remove-all"] === "true";
      } else if (change.fieldId === "keep-repo") {
        state.keepRepo = change.data["keep-repo"] === "true";
        if (state.keepRepo) {
          // Keeping the repository withdraws the implied remove-all.
          state.removeAll = false;
        }
      }
      handle.update(buildConfig());
    });

    try {
      const event = await handle.nextEvent();
      if (event.kind !== "dismiss" && event.actionId === "close") {
        const shouldDeleteRepo = isRemote && !state.keepRepo;
        return {
          removeAll: state.removeAll || shouldDeleteRepo,
          removeLocalRepo: shouldDeleteRepo,
        };
      }
      // Cancel button or Escape.
      return { canceled: true };
    } finally {
      unsubscribe();
      handle.close();
    }
  }

  return {
    name: "presentation",
    events,
    hooks: {
      [CLOSE_PROJECT_OPERATION_ID]: {
        confirm: { handler: confirmClose },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async (): Promise<void> => {
            deps.ipcLayer.removeListener(ApiIpcChannels.UI_EVENT, listener);
            modalUnsubscribe();
            if (themeUnsubscribe) {
              themeUnsubscribe();
              themeUnsubscribe = null;
            }
          },
        },
      },
    },
  };
}
