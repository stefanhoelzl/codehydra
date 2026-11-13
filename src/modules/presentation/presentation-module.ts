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
 * ground state whenever no workspace is active. A row's key is its workspace
 * ref, opaque to the renderer. Pushing starts at the renderer's ui-connected
 * handshake; the startup screen gives way to the sidebar once every startup
 * project:open has announced its workspaces (see startup-surface.ts), while
 * they are still opening.
 *
 * The factory is wiring: the view-model lives in view-model.ts, and three
 * collaborators share it with the snapshot scheduler — the startup/loading
 * system dialog (startup-surface.ts), running plugin hooks (running-hooks.ts)
 * and shortcut navigation (navigation.ts).
 */

import type { IntentModule } from "../../intents/lib/module";
import type {
  DispatchOrigin,
  InterceptContext,
  IntentInterceptor,
} from "../../intents/lib/dispatcher";
import type { Intent } from "../../intents/lib/types";
import type { HookOutput } from "../../intents/lib/operation";
import { ANY_VALUE } from "../../intents/lib/operation";
import type { IDispatcher } from "../../intents/lib/dispatcher";
import type { Logging, LoggerName, LogContext } from "../../boundaries/platform/logging";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { PathProvider } from "../../boundaries/platform/path-provider";
import type { PersistedAccessor } from "../../boundaries/platform/store-definition";
import type { StateService } from "../../boundaries/platform/state-service";
import type { IViewManager } from "../../boundaries/shell/view-manager.interface";
import type { Theme } from "../../boundaries/shell/window-manager";
import type { Unsubscribe } from "../../shared/api/interfaces";
import type { AgentStatus, DeletionProgress } from "../../shared/api/types";
import { readTitle, TAGS_METADATA_KEY_PREFIX } from "../../shared/api/types";
import { APP_SHUTDOWN_OPERATION_ID } from "../../intents/app-shutdown";
import { APP_START_OPERATION_ID } from "../../intents/app-start";
import { SETUP_OPERATION_ID } from "../../intents/setup";
import { EVENT_PROJECT_OPENED } from "../../intents/open-project";
import {
  EVENT_PROJECT_CLOSED,
  INTENT_CLOSE_PROJECT,
  CLOSE_PROJECT_OPERATION_ID,
  type CloseProjectIntent,
  type CloseConfirmHookResult,
} from "../../intents/close-project";
import {
  EVENT_WORKSPACE_CREATED,
  EVENT_WORKSPACE_LOADING,
  EVENT_WORKSPACE_CREATE_FAILED,
  INTENT_OPEN_WORKSPACE,
  type OpenWorkspacePayload,
  type WorkspaceOpenSource,
} from "../../intents/open-workspace";
import {
  CAPABILITY_AGENT_STOPPED,
  DELETE_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETION_PROGRESS,
  INTENT_DELETE_WORKSPACE,
  type DeleteWorkspaceIntent,
  type ShutdownHookResult,
} from "../../intents/delete-workspace";
import {
  EVENT_WORKSPACE_SWITCHED,
  INTENT_SWITCH_WORKSPACE,
  SWITCH_WORKSPACE_OPERATION_ID,
  type FindCandidatesHookResult,
  type SwitchWorkspaceHookResult,
  type SwitchWorkspaceIntent,
  type SwitchWorkspacePayload,
} from "../../intents/switch-workspace";
import { activeWorkspaceRef } from "../../intents/lib/active-workspace";
import { EVENT_AGENT_STATUS_UPDATED } from "../../intents/update-agent-status";
import { EVENT_METADATA_CHANGED } from "../../intents/set-metadata";
import { EVENT_SHORTCUT_ACTIVE_CHANGED } from "../../intents/set-shortcut-active";
import { EVENT_SHORTCUT_KEY_PRESSED } from "../../intents/shortcut-key";
import {
  INTENT_HIBERNATE_WORKSPACE,
  HIBERNATE_WORKSPACE_OPERATION_ID,
  type HibernateWorkspaceIntent,
  type PrepareCaptureHookResult,
  type CleanupCaptureHookResult,
} from "../../intents/hibernate-workspace";
import {
  INTENT_WAKE_WORKSPACE,
  EVENT_WORKSPACE_WAKE_FAILED,
  type WakeWorkspaceIntent,
  type WakeWorkspacePayload,
} from "../../intents/wake-workspace";
import { isShortcutKey } from "../../shared/shortcuts";
import type { AggregatedAgentStatus, UIMode } from "../../shared/ipc";
import { ApiIpcChannels } from "../../shared/ipc";
import type { DialogConfig, DialogSection } from "../../shared/dialog-types";
import { uiEventSchema } from "../../shared/ui-event";
import {
  clampSidebarWidthMin,
  compareDisplayNames,
  SIDEBAR_MODES,
  type HibernatedView,
  type SidebarMode,
  type UiDeletionProgress,
  type UiMainView,
  type UiNotification,
  type UiProjectRow,
  type UiSidebarFind,
  type UiState,
  type UiWorkspaceRow,
} from "../../shared/ui-state";
import type { Config } from "../../boundaries/platform/config";
import { storeBoolean, storeCustom, storeEnum } from "../../boundaries/platform/store-definition";
import { createProcessBar } from "./process-bar";
import { buildScreenshotPath } from "../hibernation-screenshot-module";
import {
  DialogManager,
  NotificationManager,
  type DialogHandle,
  type DialogOpenOptions,
  type NotificationSnapshot,
} from "./sessions";
import { createNotificationHooks } from "./notification-hooks";
import { createModalEdges } from "../modal-edges";
import { WAKEUP_METADATA_KEY } from "../wakeup-module";
import { getErrorMessage } from "../../shared/error-utils";
import type { ProjectRef, WorkspaceRef } from "../../intents/contract";
import { asProjectRef, makeWorkspaceRef, projectNameOf, projectRefOf } from "../../utils/ref";
import { createWorkspaceStatusCache } from "../workspace-status-cache";
import type { ProcessMonitorModule } from "../process-monitor/process-monitor-module";
import { createRunningHooks, type RunningHook } from "./running-hooks";
import { createStartupSurface } from "./startup-surface";
import { createShortcutNavigation } from "./navigation";
import {
  PresentationModel,
  compareRows,
  fromDescription,
  fromMetadata,
  readHibernatedAt,
  readTags,
  readWakeupScript,
  type ProjectModel,
  type RowEntry,
  type WorkspaceEntry,
  type WorkspaceModel,
} from "./view-model";
import { defineEvents, defineHooks, type HookInput } from "../../intents/declarations";

export interface PresentationModuleDeps {
  readonly loggingService: Pick<Logging, "createLogger">;
  readonly viewManager: Pick<
    IViewManager,
    "sendToUI" | "onFromUI" | "waitForUIPaint" | "reloadFrame"
  >;
  readonly windowManager: {
    getTheme(): Theme;
    onThemeChange(callback: (theme: Theme) => void): Unsubscribe;
    /** Whether the window has OS focus: the active workspace is only seen while it does. */
    isFocused(): boolean;
    onFocusChange(callback: (focused: boolean) => void): Unsubscribe;
  };
  readonly fileSystem: Pick<FileSystemBoundary, "readFileBuffer">;
  readonly pathProvider: PathProvider;
  readonly dispatcher: Pick<IDispatcher, "dispatch" | "withOrigin">;
  /**
   * Persisted expanded-sidebar width (px). Read into every snapshot's sidebar
   * region and written when the renderer emits a `resize-sidebar` drag result.
   */
  readonly sidebarWidthConfig: Pick<PersistedAccessor<number>, "get" | "set">;
  readonly configService: Pick<Config, "register">;
  /**
   * Runtime state store (state.json). The presenter registers
   * `sidebar.collapsed-projects` here — a user-toggled view preference, not a
   * config setting — and reads/writes it directly (mirrors silent,
   * but persisted to state.json rather than config.json).
   */
  readonly stateService: Pick<StateService, "register">;
  /**
   * An open project's badge color, an index below PROJECT_COLOR_COUNT. Wired in
   * the composition root to the local-project module, which assigns it at open
   * and keeps it in the project's record.
   */
  readonly projectColor: (projectRef: ProjectRef) => number | undefined;
  /**
   * Called when the renderer emits the `open-settings` ui event (the sidebar
   * gear). Wired in the composition root to the settings module's openSettings;
   * the presenter itself stays agnostic of the settings dialog.
   */
  readonly onOpenSettings: () => void;
  /**
   * Called when the renderer emits the `open-help` ui event (the sidebar
   * question mark). Wired in the composition root to the help module.
   */
  readonly onOpenHelp: () => void;
  /**
   * Called when the renderer emits the `open-new-workspace` ui event (a
   * sidebar + button), after the switch to the creation panel is dispatched.
   * `projectRef` is the project to preset (a project card's +), null to keep
   * the form's own choice; `deselecting` says a workspace was active, so that
   * switch is still landing. Wired in the composition root to the creation
   * module.
   */
  readonly onOpenNewWorkspace: (projectRef: ProjectRef | null, deselecting: boolean) => void;
  /**
   * Whether the New workspace form holds the user's input (the creation
   * module's `isEdited`). While it does and the form is the main view, only a
   * switch the user asked for leaves it (the keep-edited-creation-form
   * interceptor). Wired in the composition root to the creation module.
   */
  readonly creationFormEdited: () => boolean;
  /**
   * The process monitor. The presenter owns `sidebar.process-summary`: it turns
   * the monitor's polling on while the summary shows, puts each workspace's
   * totals on its row and CodeHydra's whole footprint, and its process tree,
   * on the sidebar's process bar (process-bar.ts).
   */
  readonly processMonitor: Pick<
    ProcessMonitorModule,
    "summaries" | "totals" | "trees" | "onSummaries" | "setWatching" | "killProcess"
  >;
}

export type { RunningHook } from "./running-hooks";

/**
 * The UI presenter: an IntentModule that also exposes the imperative dialog
 * command surface for any module to inject. It is the sole owner of ui:state
 * and of the UI-view IPC (both directions, via ViewManager), and privately owns
 * the Dialog/Notification managers whose state it folds into the snapshot.
 * Sidebar notifications are not on that surface: they are raised through the
 * `notification:show` / `notification:close` intents, whose hooks it handles.
 */
export interface UiPresenter extends IntentModule {
  /**
   * Open a dialog (modal, modeless, or panel — see DialogKind). Returns a handle.
   *
   * Pass `workspaceRef` when the dialog is about one workspace: together with
   * `DialogConfig.needsAttention` it marks that workspace's sidebar row while
   * the dialog is waiting on an answer.
   */
  dialog(config: DialogConfig, options?: DialogOpenOptions): DialogHandle;
  /** True while a blocking modal dialog (kind === "modal") is open (the shortcut-module Alt+X guard). */
  isModalOpen(): boolean;
  /**
   * The current full deletion progress for a workspace, or undefined when
   * it is not deleting. The presenter is the single owner of deletion progress
   * (it tracks it for row status); the deletion-dialog module reads it here for
   * its modal and retry/dismiss dispatch inputs rather than tracking its own.
   */
  deletionProgress(workspaceRef: WorkspaceRef): DeletionProgress | undefined;
  /**
   * Reload a workspace's IDE frame, if it is mounted. Returns false when there
   * is no frame to reload: unknown workspace, hibernated, still being created,
   * or released for deletion. The presenter owns frame identity, so callers
   * name the workspace and never see a frame key.
   */
  reloadFrame(workspaceRef: WorkspaceRef): boolean;
  /** Offer a Cancel for a running plugin hook until the returned function is called. */
  trackRunningHook(hook: RunningHook): () => void;
  /** Cancel every running plugin hook of a workspace (the deletion panel's Cancel). */
  cancelRunningHooks(workspaceRef: WorkspaceRef): void;
}

/**
 * Validate and convert logger name from renderer to LoggerName type.
 * Returns "ui" if the provided name is not a valid renderer logger name.
 */
const VALID_RENDERER_LOGGER_NAMES = new Set<string>(["ui", "api"]);
function toLoggerName(name: string): LoggerName {
  return VALID_RENDERER_LOGGER_NAMES.has(name) ? (name as LoggerName) : "ui";
}

/**
 * Validate `sidebar.collapsed-projects`: a list of project refs. A ref from
 * before project types reads as the git ref it names, and is written back so
 * the next time the list changes.
 */
function validateRefList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    refs.push(asProjectRef(item) ?? item);
  }
  return refs;
}

// =============================================================================
// Row helpers
// =============================================================================

/**
 * Distill the domain DeletionProgress into the render-ready row field: keep
 * only what a renderer shows (per-operation display status, completion/error
 * flags, blocking-process count) — never the WorkspaceRef/ProjectId/PIDs.
 */
function toUiDeletionProgress(progress: DeletionProgress): UiDeletionProgress {
  return {
    operations: progress.operations.map((op) => ({
      id: op.id,
      label: op.label,
      status: op.status,
      ...(op.error !== undefined && { error: op.error }),
    })),
    completed: progress.completed,
    hasErrors: progress.hasErrors,
    blockingProcessCount: progress.blockingProcesses?.length ?? 0,
  };
}

const AGENT_NONE: AgentStatus = { type: "none" };

/**
 * Counts for a workspace that is asking for attention without an agent behind
 * it — a dialog raised before any agent started, or after one was stopped.
 * One idle "thing" is the honest reading: something here is waiting on you.
 */
const ATTENTION_COUNTS = { idle: 1, busy: 0, total: 1 } as const;

/**
 * Present a status as idle, keeping whatever counts it already had.
 *
 * Used only while a dialog is waiting on the user. A busy agent shows as idle
 * for that span, which is the intent: the question outranks the turn, and the
 * agent's real status returns to the row the moment the dialog is answered.
 */
function withAttention(status: AgentStatus): AgentStatus {
  return status.type === "none"
    ? { type: "idle", counts: ATTENTION_COUNTS }
    : { type: "idle", counts: status.counts };
}

// =============================================================================
// Close-project confirmation dialog
// =============================================================================

/** User-driven state of the close-project confirmation dialog. */
interface CloseConfirmState {
  removeAll: boolean;
  /** Remote only — "Keep cloned repository", unchecked by default (delete it). */
  keepRepo: boolean;
  /** Local only — "Remove project directory from disk", unchecked by default (keep it). */
  removeRepo: boolean;
}

/**
 * Build the close confirmation DialogConfig.
 *
 * Deleting the repository directory implies removing all workspaces — their
 * worktrees would otherwise be orphaned — so the remove-all checkbox is then
 * forced checked and disabled. The polarity differs by project kind and the
 * asymmetry is deliberate: a clone lives in app-data and can be fetched
 * again, so it defaults to being deleted ("Keep cloned repository"
 * unchecked); a local directory is the user's own working copy with no
 * recovery route, so it defaults to surviving ("Remove project directory
 * from disk" unchecked). The local box also renders when the project has no
 * workspaces at all, which the remove-all box does not.
 *
 * Every checkbox opts into change events and the backend echoes its model on
 * every update (the checkbox adopt-once contract).
 */
function buildCloseConfirmConfig(
  state: CloseConfirmState,
  workspaceCount: number,
  remoteUrl: string | undefined,
  projectPath: string
): DialogConfig {
  const isRemote = remoteUrl !== undefined;
  const shouldDeleteRepo = isRemote ? !state.keepRepo : state.removeRepo;
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
  } else {
    sections.push({
      type: "checkbox",
      id: "remove-repo",
      label: "Remove project directory from disk",
      value: state.removeRepo,
      changeEvent: true,
    });
    if (shouldDeleteRepo) {
      // The path is what the user has to verify — a local project has no
      // remote URL to offer as the recovery route the clone warning names.
      sections.push({
        type: "text",
        content:
          `This will permanently delete ${projectPath}` +
          `${workspaceCount > 0 ? " and all workspaces" : ""}, ` +
          "including any uncommitted changes.",
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

  return { sections };
}

/**
 * The snapshot projection logged on every push at `debug` (minified JSON).
 *
 * A verbatim snapshot is unbounded, and two fields carry nearly all of it: a
 * hibernated `main` inlines the workspace screenshot as a base64 data URL
 * (~1.25 MB for a real 940 KB PNG), and a create-workspace dialog's `config`
 * holds one dropdown suggestion per branch (22.8 KB at 428 remote branches).
 * Re-serialised on every push, that made `[presenter]` 64% of an 11.5 MB bug
 * report — ~1 MB/hour from this one line. Dropping the dialog config also
 * keeps the settings dialog's unredacted `Config.getEffective()` values out of
 * the log file that bug reports attach.
 *
 * Everything else stays verbatim: rows are ~155 bytes each and carry what a
 * report is read for (which row hung in `creating`, which deletion failed and
 * why, which agent was busy). The mapped type is the guard — a new `UiState`
 * field fails to compile here until it is deliberately projected.
 *
 * The verbatim snapshot remains available one level down (`log.level=silly:presenter`).
 */
function projectForLog(state: UiState): string {
  const projected: { [K in keyof UiState]: unknown } = {
    sidebar: state.sidebar,
    // The mounted-frame *set* is the diagnostic fact (an orphaned frame, a
    // frame surviving a teardown); each URL is just the IDE port plus the
    // worktree path, both already elsewhere in the log.
    frames: Object.keys(state.frames),
    main:
      state.main.kind === "hibernated"
        ? { ...state.main, screenshot: state.main.screenshot?.length ?? null }
        : state.main,
    theme: state.theme,
    silent: state.silent,
    mode: state.mode,
    capturing: state.capturing,
    // Which dialogs are open, in open order — enough for the modal-stack
    // questions ("was the app blocked", "did the loading dialog never close").
    dialogs: state.dialogs.map(({ id, kind }) => ({ id, kind })),
    notifications: state.notifications,
  };
  return JSON.stringify(projected);
}

/** The row view of a tracked agent status (absent = no agent). */
function toAgentStatus(status: AggregatedAgentStatus | undefined): AgentStatus {
  if (status === undefined) return AGENT_NONE;
  const changedAt = status.changedAt !== undefined ? { changedAt: status.changedAt } : {};
  if (status.status === "none") return { ...AGENT_NONE, ...changedAt };
  const { idle, busy } = status.counts;
  return { type: status.status, counts: { idle, busy, total: idle + busy }, ...changedAt };
}

export function createPresentationModule(deps: PresentationModuleDeps): UiPresenter {
  const logger = deps.loggingService.createLogger("presenter");

  // Whether the sidebar overlays the workspace (collapsed strip, expands on
  // hover) or is docked beside it (always expanded, the workspace shrinks).
  // Read at snapshot-build time; the header button (set-sidebar-mode ui:event)
  // and Alt+X+D write it.
  const sidebarModeConfig = deps.configService.register<SidebarMode>("sidebar.mode", {
    default: "overlay",
    description:
      "Sidebar layout: overlay (expands over the workspace) | docked (always expanded, the workspace shrinks)",
    applies: "live",
    ...storeEnum(SIDEBAR_MODES),
  });

  // The process summary: whether rows show their workspace's CPU and memory,
  // and the process bar's level (`sidebar.process-summary`). The footer's
  // pulse button, the bar's level buttons and Alt+X+P write it; read at
  // snapshot-build time, which also turns the process monitor's polling on or
  // off to match.
  const processBar = createProcessBar({
    configService: deps.configService,
    stateService: deps.stateService,
    processMonitor: deps.processMonitor,
    logger,
    scheduleUpdate: () => scheduleUpdate(),
  });

  // Read at snapshot-build time, so flipping it re-pushes
  // ui:state and the very next chime is suppressed — no restart, and the
  // renderer never caches the value. The footer's speaker button (set-silent
  // ui:event) and Alt+X+M write it.
  const silentConfig = deps.configService.register("silent", {
    default: false,
    description: "Silence the audible notification played when an agent goes idle",
    applies: "live",
    ...storeBoolean(),
  });

  // Projects (by ref) whose sidebar card is collapsed to its header. A
  // user-toggled runtime preference (the card's header bar), so it lives in
  // state.json, not config. Closing a project drops its ref, so it reopens
  // expanded. The active workspace's project is never collapsed: arriving in
  // one expands it, and automatic landings skip them. Read at snapshot-build
  // time and when navigating (the arrows skip collapsed projects), so flipping
  // it re-pushes.
  const collapsedProjectsState = deps.stateService.register("sidebar.collapsed-projects", {
    default: [] as readonly string[],
    description: "Projects whose sidebar card is collapsed",
    ...storeCustom<readonly string[]>({
      parse: (raw) => {
        try {
          return validateRefList(JSON.parse(raw));
        } catch {
          return undefined;
        }
      },
      validate: validateRefList,
    }),
  });

  // Background creations whose placeholder the user clicked: once they leave
  // it, finishing must not land them back on it.
  const viewedPlaceholders = new Set<WorkspaceRef>();

  // The workspace an in-flight wake will land on when it is open: the last one
  // the user asked to wake. Any switch since cancels it, also one that changes
  // nothing main-side, so leaving and coming back does not revive it.
  let pendingWakeLanding: WorkspaceRef | null = null;

  function isCollapsed(project: ProjectModel): boolean {
    return collapsedProjectsState.get().includes(project.ref);
  }

  /**
   * How much of each project's hibernated list is shown, by project ref
   * (absent = "hidden"). Not persisted: the list folds away again as soon as
   * the pointer leaves the card, and whenever one of its workspaces hibernates.
   */
  const hibernatedViews = new Map<ProjectRef, HibernatedView>();
  /** The sidebar's Find field has the focus (null: it has not). */
  let find: UiSidebarFind | null = null;

  /** hidden → manual → all → hidden: what Alt+X, T steps through. */
  function nextHibernatedView(view: HibernatedView): HibernatedView {
    return view === "hidden" ? "manual" : view === "manual" ? "all" : "hidden";
  }

  // The presenter privately owns the dialog/notification registries. They hold
  // session state and hand out handles; every mutation calls scheduleUpdate so
  // their getSnapshot() is folded into the next ui:state push. (scheduleUpdate
  // is a hoisted function declaration below.)
  const dialogs = new DialogManager(scheduleUpdate, logger);
  const notifications = new NotificationManager(scheduleUpdate, logger);

  // ---------------------------------------------------------------------------
  // State (mirrors the renderer stores' semantics)
  // ---------------------------------------------------------------------------

  /** Projects and workspace rows, indexed by ref; the active workspace. */
  const model = new PresentationModel();
  /** Agent status by workspace ref. */
  const agents = createWorkspaceStatusCache((ref, previous, next) => {
    trackFresh(ref, previous, next);
    scheduleUpdate();
  });
  /**
   * Workspaces whose agent turned idle since the user last saw them (the
   * row's `fresh`). Turning idle from busy, mixed, none or untracked (an agent
   * that connects idle: startup, project open, wake) adds a workspace; any
   * other status drops it, and so does being seen (see markActiveSeen).
   * In memory only: after a restart every agent connects again, so is fresh.
   */
  const fresh = new Set<WorkspaceRef>();
  /** The window has OS focus; seeded and tracked from app start. */
  let windowFocused = false;

  function trackFresh(
    ref: WorkspaceRef,
    previous: AggregatedAgentStatus | undefined,
    next: AggregatedAgentStatus | undefined
  ): void {
    if (next?.status !== "idle") fresh.delete(ref);
    else if (previous?.status !== "idle") fresh.add(ref);
  }

  /** The active workspace, in a focused window, is seen: it is not fresh. */
  function markActiveSeen(): void {
    if (windowFocused && model.activeRef !== null) fresh.delete(model.activeRef);
  }
  /**
   * Deletion lifecycle keyed by workspace ref (absent = not deleting). The
   * single source of truth for deletion progress: the row's render-ready
   * `deletionProgress` + `status` derive from it, and the deletion-dialog
   * module reads it (via the `deletionProgress` accessor) for its modal +
   * retry/dismiss dispatch inputs instead of tracking its own copy. Holds the
   * full domain `DeletionProgress` because the modal needs fields the
   * render-ready row view omits (blocking-process pids, keepBranch).
   */
  const deletions = new Map<WorkspaceRef, DeletionProgress>();
  /**
   * Workspaces whose IDE frame may be dropped from the `frames` region, keyed
   * by workspace ref.
   *
   * Populated by the delete "shutdown" handler below, which the dispatcher
   * defers until the agent has been stopped. Deletion progress alone is NOT
   * enough: the first progress event is emitted before the shutdown hook point
   * runs, so unmounting on it tears down the IDE connection the graceful agent
   * exit is still talking over.
   */
  const framesReleased = new Set<WorkspaceRef>();
  /** Hibernation screenshot data URLs keyed by workspace ref (null = missing). */
  const screenshots = new Map<WorkspaceRef, string | null>();
  const screenshotLoads = new Set<WorkspaceRef>();
  let theme: Theme = "dark";
  /**
   * The snapshot stream gate. Set true on the `ui-connected` handshake (App
   * mount, during app:start). Pushes are gated on this — the view-model is
   * maintained from genesis, but nothing leaves main until the renderer has
   * subscribed. The genesis snapshot is flushed immediately on connect.
   */
  let connected = false;
  /**
   * A push is queued or under way: further schedule requests ride on it. Held
   * through the reconciliation at the top of push(), whose own dialog and
   * notification mutations that push already carries.
   */
  let pushScheduled = false;
  let themeUnsubscribe: Unsubscribe | null = null;
  let focusUnsubscribe: Unsubscribe | null = null;
  // Each process scan's totals land on the rows; re-push when they change.
  const unsubscribeProcessSummaries = deps.processMonitor.onSummaries(() => scheduleUpdate());

  // --- UI mode inputs (main-owned). Mode = shortcut > dialog > hover >
  //     workspace, computed in buildMode() from these four signals.
  /** Alt+X shortcut mode active (owned by shortcut-module, signalled here). */
  let shortcutActive = false;
  /** Last settled hover region from the renderer's `hover` ui:event. */
  let hoverRegion: "sidebar" | null = null;
  /**
   * True only between the hibernate `prepare-capture` and `cleanup-capture`
   * hooks, while the active workspace's screenshot is being taken. Forces the
   * sidebar collapsed in the snapshot so it is not baked into the shot.
   */
  let capturing = false;

  // ---------------------------------------------------------------------------
  // Collaborators: running plugin hooks, the startup/loading system dialog,
  // shortcut navigation. Each gets the model and scheduleUpdate.
  // ---------------------------------------------------------------------------

  const runningHooks = createRunningHooks({
    notifications,
    scheduleUpdate,
    projectName: (workspaceRef) => {
      const projectRef = projectRefOf(workspaceRef);
      return model.projects.get(projectRef)?.name ?? projectNameOf(projectRef);
    },
  });

  const startup = createStartupSurface({
    dialogs,
    model,
    runningHooks,
    dispatcher: deps.dispatcher,
    logger,
    scheduleUpdate,
    rows: currentRows,
    collapsed: isCollapsed,
    retryOpen,
    deleteWorkspace: dispatchInteractiveDelete,
  });

  const runShortcutKey = createShortcutNavigation({
    model,
    rows: currentRows,
    rowStatus,
    dispatch: dispatchDetached,
    deleteWorkspace: dispatchInteractiveDelete,
    collapsed: isCollapsed,
    cycleHibernatedView,
    toggleActiveCollapsed,
    openFind: () => setFind(true),
    toggleSidebarMode: () =>
      setSidebarMode(sidebarModeConfig.get() === "docked" ? "overlay" : "docked"),
    toggleProcessSummary: () => processBar.toggle(),
    toggleSilent: () => setSilent(!silentConfig.get()),
  });

  /** Whether a workspace's IDE frame is in the snapshot's `frames` region. */
  function isFrameMounted(workspace: WorkspaceModel): boolean {
    const released = framesReleased.has(workspace.ref);
    return workspace.url !== undefined && !workspace.hibernated && !released;
  }

  function reloadFrame(workspaceRef: WorkspaceRef): boolean {
    const found = model.find(workspaceRef);
    if (found === undefined || !isFrameMounted(found.workspace)) return false;
    deps.viewManager.reloadFrame(workspaceRef);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Snapshot building + push
  // ---------------------------------------------------------------------------

  function rowStatus(workspace: WorkspaceModel): UiWorkspaceRow["status"] {
    const progress = deletions.get(workspace.ref);
    if (progress) return progress.completed && progress.hasErrors ? "delete-failed" : "deleting";
    return workspace.phase;
  }

  /**
   * Resolve the hibernation screenshot for the active workspace. Reads are
   * async: the first snapshot carries null and a re-push follows once the
   * PNG is loaded (or confirmed missing).
   */
  function resolveScreenshot({ project, workspace }: WorkspaceEntry): string | null {
    const ref = workspace.ref;
    const cached = screenshots.get(ref);
    if (cached !== undefined) return cached;
    if (!screenshotLoads.has(ref)) {
      screenshotLoads.add(ref);
      const filePath = buildScreenshotPath(deps.pathProvider, project.id, workspace.name);
      deps.fileSystem
        .readFileBuffer(filePath)
        .then((png) => {
          screenshots.set(ref, `data:image/png;base64,${png.toString("base64")}`);
        })
        .catch(() => {
          screenshots.set(ref, null);
        })
        .finally(() => {
          screenshotLoads.delete(ref);
          scheduleUpdate();
        });
    }
    return null;
  }

  /**
   * Build a UiWorkspaceRow for a workspace (single source of truth for both
   * the snapshot and shortcut navigation, so they always agree on ordering and
   * status). The row's key is the workspace ref.
   */
  function buildRow(workspace: WorkspaceModel): UiWorkspaceRow {
    const progress = deletions.get(workspace.ref);
    const agent = toAgentStatus(agents.statuses.get(workspace.ref));
    // A workspace still being created has its ref already, so the first
    // hook-trust question (raised during after-worktree-created) marks its
    // placeholder row too.
    const waitingOnUser = dialogs.needsAttentionFor(workspace.ref);
    // Hibernation killed everything in it, so a sleeping row shows no summary.
    const processes = workspace.hibernated ? undefined : processBar.rowSummary(workspace.ref);
    return {
      key: workspace.ref,
      name: workspace.name,
      ...(workspace.title !== undefined && { title: workspace.title }),
      ...(workspace.subtitle !== undefined && { subtitle: workspace.subtitle }),
      ...(workspace.subtitleIcon !== undefined && { subtitleIcon: workspace.subtitleIcon }),
      status: rowStatus(workspace),
      hibernated: workspace.hibernated,
      ...(workspace.hibernated &&
        workspace.hibernatedAt !== undefined && { hibernatedAt: workspace.hibernatedAt }),
      ...(workspace.hibernated &&
        workspace.wakeupScript !== undefined && { wakeupScript: workspace.wakeupScript }),
      // A dialog waiting on the user reads as idle for as long as it waits: the
      // green row (and the chime the renderer derives from these counts) is the
      // signal the user already answers to, and a question nobody notices is
      // the same as no question. Reverts on its own — the next snapshot reads
      // the tracked status again once the dialog closes or drops the flag.
      agent: waitingOnUser ? withAttention(agent) : agent,
      // A waiting question stays fresh until answered, seen or not.
      fresh: waitingOnUser || (agent.type === "idle" && fresh.has(workspace.ref)),
      // Copy: the model array mutates on tag changes; snapshots are immutable values.
      tags: [...workspace.tags],
      active: workspace.ref === model.activeRef,
      ...(workspace.openError !== undefined && { openError: workspace.openError }),
      // Derive the render-ready row view from the full tracked progress.
      ...(progress && { deletionProgress: toUiDeletionProgress(progress) }),
      ...(processes !== undefined && {
        processes: {
          cpuPercent: processes.cpuPercent,
          rssBytes: processes.rssBytes,
          count: processes.count,
        },
      }),
    };
  }

  /**
   * Projects in display order (AaBbCc), each with its rows in display order:
   * hibernated (most recent first), then automated, then awake by name (see
   * compareRows).
   */
  function sortedProjects(): Array<[ProjectModel, WorkspaceModel[]]> {
    return [...model.workspacesByProject()]
      .sort(([a], [b]) => compareDisplayNames(a.name, b.name))
      .map(([project, workspaces]) => [
        project,
        workspaces.sort((a, b) => compareRows(a, b, compareDisplayNames)),
      ]);
  }

  /**
   * All workspace rows in sidebar display order — the authoritative ordering
   * shared by the snapshot (buildSnapshot) and shortcut navigation, which
   * itself skips the rows of collapsed projects.
   */
  function currentRows(): RowEntry[] {
    const entries: RowEntry[] = [];
    for (const [project, workspaces] of sortedProjects()) {
      for (const workspace of workspaces) {
        entries.push({ row: buildRow(workspace), project, workspace });
      }
    }
    return entries;
  }

  function buildMain(): UiMainView {
    // The startup flow (every phase before app:started) shows nothing in main:
    // a blank base under the reconciled system dialog. `starting` is the single
    // marker the renderer reads to keep MainView unmounted (showMain stays
    // false until main.kind flips to a running kind at app:started).
    if (!startup.isDone()) return { kind: "starting" };

    // The creation panel is the ground state: shown whenever nothing is
    // active (including a stale active ref whose workspace is gone).
    const active = model.active();
    if (active === undefined) return { kind: "creation" };
    if (active.workspace.hibernated) {
      return {
        kind: "hibernated",
        screenshot: resolveScreenshot(active),
        hibernatedAt: active.workspace.hibernatedAt ?? null,
      };
    }
    // A still-creating active workspace has no mounted frame yet (its key is
    // absent from `frames`), so the workspace area is blank behind the
    // reconciled mid-session loading dialog until workspace:created arrives.
    return { kind: "workspace", frameKey: active.workspace.ref };
  }

  /**
   * Compute the single UI mode. Priority shortcut > dialog > hover > workspace.
   * The creation panel (no active workspace) maps to hover-level: UI on top but
   * Alt+X still works.
   *
   * Takes the creation-panel flag rather than the whole main view so the
   * focus-suppression interceptor can ask for the current mode without building
   * a main view (buildMain resolves screenshots, which kicks off a file read).
   */
  function buildMode(creationMain: boolean): UIMode {
    // The startup surfaces are modal system dialogs, so isModalOpen() already
    // yields "dialog" for them — no startup special-case needed. The mid-session
    // loading surface is a "panel" (not modal), so it falls through to the
    // active workspace's mode, keeping the sidebar navigable — same as the
    // deletion panel.
    if (shortcutActive) return "shortcut";
    if (dialogs.isModalOpen()) return "dialog";
    // The Find field keeps the sidebar expanded like a hover: it is typed into.
    if (creationMain || hoverRegion === "sidebar" || find !== null) return "hover";
    return "workspace";
  }

  /** The mode the next snapshot would carry (buildMain's `creation` condition inlined). */
  function currentMode(): UIMode {
    return buildMode(startup.isDone() && model.active() === undefined);
  }

  // ---------------------------------------------------------------------------
  // Background-focus suppression
  //
  // A workspace an agent opens in the background (MCP, the API server, an
  // auto-workspace source with focus: true) asks to steal the view by passing
  // stealFocus: true. That is jarring while the user is reading the expanded
  // sidebar — the view yanks out from under the cursor. This interceptor
  // downgrades such a request to stealFocus: false whenever the sidebar is
  // expanded (mode !== "workspace"), so the open still happens but the view
  // stays put. The row itself is unaffected: workspace:loading now fires for
  // every fresh creation, so it arrives (flashing via Sidebar's in:arrivalFlash)
  // the moment the open starts either way — only whether it takes the view
  // depends on this. Its blue "new" tag clears on the first switch to it.
  //
  // Interactive sources (ui-ipc, creation, open-project) are never touched, so
  // clicking a hibernated row or creating from the New workspace panel still
  // switches even though those happen in hover mode. Wakes count: a background
  // wake (existingWorkspace set) yanks the view just as much as a fresh open.
  //
  // Evaluated when the open STARTS, not when the switch would land — creation
  // takes seconds, so leaving the sidebar mid-creation still suppresses. That is
  // the intended bias: err toward not stealing focus.
  const BACKGROUND_OPEN_SOURCES: ReadonlySet<WorkspaceOpenSource> = new Set([
    "mcp",
    "api-server",
    "auto-workspace",
  ]);

  const suppressBackgroundFocus: IntentInterceptor = {
    id: "suppress-background-focus",
    before: async (intent: Intent): Promise<Intent | null> => {
      if (intent.type !== INTENT_OPEN_WORKSPACE) return intent;
      const payload = intent.payload as OpenWorkspacePayload;
      if (payload.stealFocus === false) return intent;
      if (payload.source === undefined || !BACKGROUND_OPEN_SOURCES.has(payload.source)) {
        return intent;
      }
      if (currentMode() === "workspace") return intent;
      return { ...intent, payload: { ...payload, stealFocus: false } };
    },
  };

  const trackWakeLanding: IntentInterceptor = {
    id: "track-wake-landing",
    before: async (intent: Intent): Promise<Intent | null> => {
      if (intent.type !== INTENT_WAKE_WORKSPACE) return intent;
      const { workspaceRef, stealFocus } = intent.payload as WakeWorkspacePayload;
      if (stealFocus !== false) pendingWakeLanding = workspaceRef;
      return intent;
    },
  };

  // ---------------------------------------------------------------------------
  // Keep an edited New workspace form on screen
  //
  // While the New workspace form is the main view and holds the user's input,
  // only a switch the user asked for leaves it: a click or key in the sidebar
  // (origin "ui"), shortcut mode ("shortcut"), or an OS notification click
  // ("notification"). Everything else is dropped: a background creation or wake
  // landing, an agent's `ch ws switch`, an automation's focus. Nothing typed would
  // be lost (the creation module keeps the form), but the view and the caret
  // would be pulled from under the user mid-sentence.
  //
  // The origin is the dispatch's own or inherited one, so a landing nested in a
  // user's own action (a creation or wake started from the UI) still counts as
  // the user's. An allow-list, so a new entry point is kept out until it says
  // it acts for the user. A drop is not deferred: the row, and a new
  // workspace's "new" tag, is the signal that something finished.
  const USER_SWITCH_ORIGINS: ReadonlySet<DispatchOrigin> = new Set([
    "ui",
    "shortcut",
    "notification",
  ]);

  const keepEditedCreationForm: IntentInterceptor = {
    id: "keep-edited-creation-form",
    before: async (intent: Intent, { origin }: InterceptContext): Promise<Intent | null> => {
      if (intent.type !== INTENT_SWITCH_WORKSPACE) return intent;
      const payload = intent.payload as SwitchWorkspacePayload;
      // A deselect lands on the form itself; an auto-select's chosen target is
      // dispatched as a nested switch, and judged then.
      if ("auto" in payload || payload.workspaceRef === null) return intent;
      if (origin !== undefined && USER_SWITCH_ORIGINS.has(origin)) return intent;
      if (!startup.isDone() || model.active() !== undefined) return intent;
      if (!deps.creationFormEdited()) return intent;
      logger.debug("Kept the edited New workspace form: dropped a switch", {
        workspace: payload.workspaceRef,
        origin: origin ?? "none",
      });
      return null;
    },
  };

  function buildSnapshot(): UiState {
    const projects = sortedProjects();
    // Also polls only while the summary shows. Idempotent; here so that a change
    // of the key from anywhere (settings dialog, `ch config`) applies on the next push.
    const processFields = processBar.sidebarFields(
      projects.map(([project, workspaces]) => ({ id: project.id, name: project.name, workspaces }))
    );
    const projectRows: UiProjectRow[] = projects.map(([project, workspaces]) => ({
      id: project.id,
      name: project.name,
      title: project.remoteUrl ?? project.path,
      remote: project.remoteUrl !== undefined,
      colorIndex: deps.projectColor(project.ref) ?? 0,
      workspaces: workspaces.map(buildRow),
      collapsed: isCollapsed(project),
      hibernatedView: hibernatedViews.get(project.ref) ?? "hidden",
    }));

    const frames: Record<string, string> = {};
    for (const { workspace } of model.workspaces.values()) {
      // A mounted frame is a live IDE client: the workspace stays open in the
      // IDE server, which keeps its pty host, extension host and file watchers
      // holding the directory. Unmount during the teardown, rather than on
      // workspace:deleted — that only fires AFTER the worktree removal has
      // already had to fight those handles (and never at all when the removal
      // fails).
      //
      // But NOT on deletion progress alone. The first progress event is
      // emitted before the delete "shutdown" hook point runs, and unmounting
      // there drops the iframe, which disconnects the IDE client and disposes
      // the extension host — out from under the graceful agent exit that is
      // still talking over it. The agent then survives as an orphan with the
      // workspace as its CWD, and Windows refuses to remove the directory.
      // So the release is gated on `framesReleased`, which the shutdown
      // handler below fills once the agent has actually been stopped.
      //
      // Nothing is hidden by this. The pipeline switches away from the
      // workspace at the start, and if the user navigates back the deletion
      // module puts its progress panel over the workspace area — the panel is
      // documented as rendering "over the already-torn-down frame". Dismissing
      // that panel dispatches a force delete, so an entry here can never
      // outlive the workspace.
      if (workspace.url !== undefined && isFrameMounted(workspace)) {
        frames[workspace.ref] = workspace.url;
      }
    }

    const main = buildMain();
    return {
      // Clamp the stored width to the shared minimum so a hand-edited
      // config.json below the floor still yields a sane snapshot; the renderer
      // additionally clamps to its window-relative maximum.
      sidebar: {
        projects: projectRows,
        width: clampSidebarWidthMin(deps.sidebarWidthConfig.get()),
        mode: sidebarModeConfig.get(),
        find,
        ...processFields,
      },
      frames,
      main,
      theme,
      silent: silentConfig.get(),
      mode: buildMode(main.kind === "creation"),
      capturing,
      dialogs: dialogs.getSnapshot(),
      notifications: notifications.getSnapshot().map(toUiNotification),
    };
  }

  /**
   * Render-ready card: the attached workspace's ref becomes its row key and
   * display name. A card whose workspace has no row (mid-teardown) renders as
   * unattached rather than carrying a key nothing would answer to.
   */
  function toUiNotification(card: NotificationSnapshot): UiNotification {
    const base: UiNotification = { id: card.id, config: card.config, count: card.count };
    const workspace = model.find(card.workspaceRef ?? null)?.workspace;
    if (workspace === undefined) return base;
    return { ...base, workspace: { key: workspace.ref, name: workspace.title ?? workspace.name } };
  }

  function scheduleUpdate(): void {
    if (!connected || pushScheduled) return;
    pushScheduled = true;
    queueMicrotask(push);
  }

  function push(): void {
    // Project the startup/loading system dialog and the hook cards from state
    // before snapshotting, so this push carries them (and mode reads
    // isModalOpen()). Their mutations schedule an update, which this push
    // already carries: hold pushScheduled so they don't queue a redundant one.
    pushScheduled = true;
    startup.reconcile();
    runningHooks.reconcileNotifications(
      (hook) =>
        startup.isShuttingDown() ||
        !startup.isDone() ||
        model.active()?.workspace.ref === hook.workspaceRef
    );
    pushScheduled = false;
    // Every change that can make a workspace seen (a switch, the window
    // gaining focus, an agent finishing under the user's eyes) pushes, so
    // settling it here covers them all.
    markActiveSeen();
    const snapshot = buildSnapshot();
    deps.viewManager.sendToUI(ApiIpcChannels.UI_STATE, snapshot);
    // Two fidelities, same message: `state` is the bounded projection every
    // debug-level bug report carries, `snapshot` the verbatim dump (both fire
    // at silly — the projection stays greppable either way).
    logger.debug("ui:state push", { state: projectForLog(snapshot) });
    logger.silly("ui:state push", { snapshot: JSON.stringify(snapshot) });
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

  /**
   * Run a failed open again. A wake is that open (workspace:open against the
   * existing worktree); the row loads until its workspace:created, or fails
   * again with the new reason.
   */
  function retryOpen(workspaceRef: WorkspaceRef): void {
    const workspace = model.find(workspaceRef)?.workspace;
    if (workspace?.phase !== "open-failed") return;
    workspace.phase = "loading";
    delete workspace.openError;
    scheduleUpdate();
    dispatchDetached({
      type: INTENT_WAKE_WORKSPACE,
      payload: { workspaceRef: workspace.ref, source: "ui-ipc" },
    });
  }

  /** The interactive remove flow (shared by the ui:event and shortcut delete). */
  function dispatchInteractiveDelete(workspaceRef: WorkspaceRef): void {
    dispatchDetached({
      type: INTENT_DELETE_WORKSPACE,
      payload: {
        workspaceRef,
        force: false,
        removeWorktree: true,
        interactive: true,
      },
    });
  }

  /**
   * Resolve the workspace an echoed row key names, for a request that needs an
   * existing workspace. A stale key (the workspace vanished since the snapshot)
   * is dropped with a warning, like stale metadata; so is a still-creating
   * placeholder, which has nothing to act on yet.
   */
  function existingWorkspace(kind: string, key: string): WorkspaceModel | undefined {
    const workspace = model.find(key)?.workspace;
    if (workspace === undefined || workspace.phase === "creating") {
      logger.warn(`Dropped ${kind} for unknown key`, { key });
      return undefined;
    }
    return workspace;
  }

  const listener = (...args: unknown[]): void => {
    const result = uiEventSchema.safeParse(args[0]);
    if (!result.success) {
      logger.warn("Dropped invalid ui event", {
        issue: result.error.issues[0]?.message ?? "unknown",
      });
      return;
    }
    const event = result.data;
    switch (event.kind) {
      case "ui-connected":
        // Startup handshake: the renderer has mounted (App, during the
        // initializing phase) and subscribed to ui:state. Open the snapshot
        // stream and flush the current snapshot immediately — startup state may
        // already be set (the genesis "starting" splash, or setup mid-flight),
        // and there is no replay. app:ready is NOT dispatched here: the
        // app:start `start` hook owns that now (after setup completes).
        // Buffering of pre-connect notifications is handled by this same gate:
        // their state lives in the snapshot, which only ships once connected.
        connected = true;
        push();
        return;
      case "log":
        try {
          const target = deps.loggingService.createLogger(toLoggerName(event.logger));
          target[event.level](event.message, event.context as LogContext | undefined);
        } catch {
          // Swallow errors - logging should never crash the app
        }
        return;
      case "remove-workspace": {
        const workspace = existingWorkspace(event.kind, event.key);
        if (workspace) dispatchInteractiveDelete(workspace.ref);
        return;
      }
      case "switch-workspace": {
        // key null = deselect (the creation panel becomes the main view).
        if (event.key === null) {
          dispatchDetached({ type: INTENT_SWITCH_WORKSPACE, payload: { workspaceRef: null } });
          return;
        }
        // Resolve the echoed key; a stale key has nothing to switch to. focus
        // is omitted: a click focuses the workspace (the keyboard nav path
        // passes focus:false).
        const workspace = model.find(event.key)?.workspace;
        if (!workspace) {
          logger.warn("Dropped switch-workspace for unknown key", { key: event.key });
          return;
        }
        // A still-creating placeholder has no path to switch to yet: only the
        // view moves to its loading panel, and workspace:created makes it active.
        // Deliberately, moving the view away from a placeholder never evicts it:
        // its lifetime is owned solely by workspace:created (swap) and
        // workspace:create-failed (remove).
        if (workspace.phase === "creating") {
          viewedPlaceholders.add(workspace.ref);
          model.activeRef = workspace.ref;
          expandActiveProject();
          scheduleUpdate();
          return;
        }
        dispatchDetached({
          type: INTENT_SWITCH_WORKSPACE,
          payload: { workspaceRef: workspace.ref },
        });
        return;
      }
      case "wake-workspace": {
        const workspace = existingWorkspace(event.kind, event.key);
        if (!workspace) return;
        // A failed open's Retry: waking runs the same open again.
        if (workspace.phase === "open-failed") {
          retryOpen(workspace.ref);
          return;
        }
        dispatchDetached({
          type: INTENT_WAKE_WORKSPACE,
          payload: { workspaceRef: workspace.ref, source: "ui-ipc" },
        });
        return;
      }
      case "hibernate-workspace": {
        const workspace = existingWorkspace(event.kind, event.key);
        if (!workspace) return;
        dispatchDetached({
          type: INTENT_HIBERNATE_WORKSPACE,
          payload: { workspaceRef: workspace.ref },
        });
        return;
      }
      case "hover":
        hoverRegion = event.region === "sidebar" ? "sidebar" : null;
        scheduleUpdate();
        return;
      case "open-settings":
        deps.onOpenSettings();
        return;
      case "open-help":
        deps.onOpenHelp();
        return;
      case "toggle-project-collapsed": {
        const project = knownProject(event.kind, event.projectId);
        if (project) toggleCollapsed(project);
        return;
      }
      case "set-hibernated-view": {
        const project = knownProject(event.kind, event.projectId);
        if (project) setHibernatedView(project, event.view);
        return;
      }
      case "set-find":
        setFind(event.active);
        return;
      case "open-new-workspace": {
        const project =
          event.projectId === null ? undefined : knownProject(event.kind, event.projectId);
        if (event.projectId !== null && project === undefined) return;
        const deselecting = model.activeRef !== null;
        dispatchDetached({ type: INTENT_SWITCH_WORKSPACE, payload: { workspaceRef: null } });
        deps.onOpenNewWorkspace(project?.ref ?? null, deselecting);
        return;
      }
      case "set-sidebar-mode":
        setSidebarMode(event.mode);
        return;
      case "set-silent":
        setSilent(event.silent);
        return;
      case "set-sidebar-process-summary":
        processBar.setMode(event.mode);
        return;
      case "resize-process-tree":
        processBar.resizeTree(event.fraction);
        return;
      case "kill-process":
        processBar.kill(event.pid, event.startedAt);
        return;
      case "resize-sidebar": {
        // Persist the drag result. Clamp to the shared minimum (the renderer
        // already enforces both bounds, but main owns what lands in config); the
        // window-relative maximum stays renderer-side. Echo the canonical value
        // back in the next snapshot so any renderer converges.
        const width = clampSidebarWidthMin(event.width);
        void deps.sidebarWidthConfig.set(width).catch((error: unknown) => {
          logger.warn("Failed to persist sidebar width", { error: getErrorMessage(error) });
        });
        scheduleUpdate();
        return;
      }
      // Dialog/notification user interactions: route to the owning session. The
      // session owner's listeners (onChange/nextEvent/onEvent) drive any follow-up
      // (update/close, which schedule a snapshot push of their own).
      case "dialog-action":
        dialogs.routeEvent({
          kind: "action",
          dialogId: event.dialogId,
          actionId: event.actionId,
          ...(event.data !== undefined && { data: event.data }),
        });
        return;
      case "dialog-change":
        dialogs.routeEvent({
          kind: "change",
          dialogId: event.dialogId,
          fieldId: event.fieldId,
          data: event.data,
        });
        return;
      case "dialog-dismiss":
        dialogs.routeEvent({ kind: "dismiss", dialogId: event.dialogId });
        return;
      case "notification-event":
        notifications.routeEvent({
          notificationId: event.notificationId,
          actionId: event.actionId,
        });
        return;
      case "close-project": {
        const project = model.projectById(event.projectId);
        if (!project) {
          logger.warn("Dropped close-project for unknown project", { projectId: event.projectId });
          return;
        }
        dispatchDetached({
          type: INTENT_CLOSE_PROJECT,
          payload: { projectRef: project.ref, interactive: true },
        });
        return;
      }
    }
  };

  // Everything the UI asks for — directly here, or through the dialogs and
  // forms this routes events to — is dispatched with origin "ui".
  const unsubscribeFromUI = deps.viewManager.onFromUI(ApiIpcChannels.UI_EVENT, (...args) =>
    deps.dispatcher.withOrigin({ origin: "ui" }, () => listener(...args))
  );

  /** The project an echoed projectId names; a stale one is dropped with a warning. */
  function knownProject(kind: string, projectId: string): ProjectModel | undefined {
    const project = model.projectById(projectId);
    if (!project) logger.warn(`Dropped ${kind} for unknown project`, { projectId });
    return project;
  }

  /**
   * Collapse or expand one project card (the `sidebar.collapsed-projects`
   * state) and re-push. Persist failures are logged but not surfaced — the
   * in-memory flip already took effect via the snapshot; the value simply
   * won't survive a restart.
   *
   * Collapsing the project of the active workspace moves on, as Alt+X, Down
   * would from its last workspace: to the first awake workspace of the next
   * expanded project, wrapping round. With none, nothing is active and the
   * creation panel shows.
   */
  function toggleCollapsed(project: ProjectModel): void {
    const collapsing = !isCollapsed(project);
    setCollapsedProjects(
      collapsing
        ? [...collapsedProjectsState.get(), project.ref]
        : collapsedProjectsState.get().filter((ref) => ref !== project.ref)
    );
    if (!collapsing || model.active()?.project !== project) return;
    const projects = sortedProjects();
    const index = projects.findIndex(([candidate]) => candidate === project);
    const after = [...projects.slice(index + 1), ...projects.slice(0, index)];
    dispatchDetached({
      type: INTENT_SWITCH_WORKSPACE,
      payload: { workspaceRef: firstAwakeExpanded(after), focus: false },
    });
  }

  function setCollapsedProjects(next: readonly string[]): void {
    void collapsedProjectsState.set(next).catch((error: unknown) => {
      logger.warn("Failed to persist collapsed project", { error: getErrorMessage(error) });
    });
    scheduleUpdate();
  }

  /** Where an automatic landing goes among `projects`: never into a collapsed one. */
  function firstAwakeExpanded(
    projects: ReadonlyArray<readonly [ProjectModel, readonly WorkspaceModel[]]>
  ): WorkspaceRef | null {
    for (const [project, workspaces] of projects) {
      if (isCollapsed(project)) continue;
      const target = workspaces.find((w) => !w.hibernated && w.phase !== "creating");
      if (target !== undefined) return target.ref;
    }
    return null;
  }

  /**
   * Arriving in a collapsed project expands it, as a click on its header does.
   * Not at startup: projects keep their saved state, and the landing that ends
   * startup skips collapsed ones.
   */
  function expandActiveProject(): void {
    const project = model.active()?.project;
    if (project === undefined || !startup.isDone() || !isCollapsed(project)) return;
    setCollapsedProjects(collapsedProjectsState.get().filter((ref) => ref !== project.ref));
  }

  /** Show part of a project's hibernated list, or fold it away ("hidden"). */
  function setHibernatedView(project: ProjectModel, view: HibernatedView): void {
    if ((hibernatedViews.get(project.ref) ?? "hidden") === view) return;
    if (view === "hidden") hibernatedViews.delete(project.ref);
    else hibernatedViews.set(project.ref, view);
    scheduleUpdate();
  }

  /**
   * Alt+X, T: while Find is open, step its view (every project at once);
   * otherwise step the active workspace's project. No-op without either.
   */
  function cycleHibernatedView(): void {
    if (find !== null) {
      find = { hibernatedView: nextHibernatedView(find.hibernatedView) };
      scheduleUpdate();
      return;
    }
    const project = model.active()?.project;
    if (project === undefined) return;
    setHibernatedView(project, nextHibernatedView(hibernatedViews.get(project.ref) ?? "hidden"));
  }

  /**
   * Alt+X, C: collapse or expand the active workspace's project, as a click
   * on its header does (collapsing moves on to the next expanded project).
   * No-op without one, and while Find is open (Find expands every project).
   */
  function toggleActiveCollapsed(): void {
    if (find !== null) return;
    const project = model.active()?.project;
    if (project !== undefined) toggleCollapsed(project);
  }

  /**
   * Open or close the Find state. Opening starts at the manual hibernated view
   * (automated ones hidden); reopening while open keeps the current view. The
   * renderer focuses the field when it sees `sidebar.find` appear (Alt+X, F)
   * and reports focus changes back through `set-find`.
   */
  function setFind(active: boolean): void {
    if (active === (find !== null)) return;
    find = active ? { hibernatedView: "manual" } : null;
    scheduleUpdate();
  }

  /**
   * Write `sidebar.mode` and re-push. Driven by the sidebar header button
   * (ui:event) and, as a toggle, by the Alt+X+D shortcut. `set()` updates the
   * effective value before it persists, so the next snapshot carries the new
   * mode even if the write to config.json fails (logged, not surfaced).
   */
  function setSidebarMode(mode: SidebarMode): void {
    void sidebarModeConfig.set(mode).catch((error: unknown) => {
      logger.warn("Failed to persist sidebar mode", { error: getErrorMessage(error) });
    });
    scheduleUpdate();
  }

  function setSilent(silent: boolean): void {
    void silentConfig.set(silent).catch((error: unknown) => {
      logger.warn("Failed to persist silent", { error: getErrorMessage(error) });
    });
    scheduleUpdate();
  }

  // ---------------------------------------------------------------------------
  // Domain event subscriptions (main → view-model)
  // ---------------------------------------------------------------------------

  const events = defineEvents({
    ...startup.events,
    [EVENT_PROJECT_OPENED]: {
      handler: async (event): Promise<void> => {
        const { project } = event.payload;
        if (model.projects.has(project.ref)) return;
        model.addProject(
          {
            ref: project.ref,
            id: project.id,
            name: project.name,
            path: project.path,
            remoteUrl: project.remoteUrl,
          },
          project.workspaces.map((workspace) => ({
            ref: workspace.ref,
            name: workspace.name,
            ...fromDescription(workspace),
            ...fromMetadata(workspace.metadata),
            url: workspace.url,
            // project:open opens every awake workspace after announcing
            // the project; hibernated ones stay as they are.
            phase: workspace.metadata["hibernated"] === "true" ? "ready" : "loading",
          }))
        );
        startup.settleStartupOpen(event);
        scheduleUpdate();
      },
    },
    [EVENT_PROJECT_CLOSED]: {
      handler: async (event): Promise<void> => {
        const { projectRef } = event.payload;
        const project = model.projects.get(projectRef);
        if (!project) return;
        const containedActive = model.active()?.project === project;
        model.removeProject(projectRef);
        // Closed means forgotten: opening it again starts expanded.
        if (isCollapsed(project)) {
          setCollapsedProjects(collapsedProjectsState.get().filter((ref) => ref !== projectRef));
        }
        if (containedActive) {
          const target = firstAwakeExpanded(sortedProjects());
          model.activeRef = target;
          // With no project left, project:close has already deselected.
          if (model.projects.size > 0) {
            dispatchDetached({ type: INTENT_SWITCH_WORKSPACE, payload: { workspaceRef: target } });
          }
        }
        scheduleUpdate();
      },
    },
    [EVENT_WORKSPACE_CREATED]: {
      handler: async (event): Promise<void> => {
        const p = event.payload;
        const project = model.projects.get(p.projectRef);
        if (project) {
          // Setting by ref replaces a creating placeholder in place.
          model.putWorkspace(project, {
            ref: p.workspaceRef,
            name: p.workspaceName,
            ...fromDescription(p),
            ...fromMetadata(p.metadata),
            url: p.workspaceUrl,
            phase: "ready",
          });
          // A wake delivers a fresh URL; any cached screenshot is stale.
          screenshots.delete(p.workspaceRef);
        }
        // A finished creation lands only if the view is still on its placeholder
        // (only the view is ever on one: a placeholder has no workspace to
        // switch to yet), or, for a background creation nobody looked at, if
        // nothing is active. Having left it, for another workspace or the
        // creation panel, the user is not pulled back: the row (plus its "new"
        // tag) is the signal that it finished.
        // A background one never lands in a collapsed project.
        //
        // A wake lands only if the user asked for it (no stealFocus false) and
        // has not switched anywhere since; it has no placeholder to stay on.
        const viewed = viewedPlaceholders.delete(p.workspaceRef);
        const wakeLanding = pendingWakeLanding === p.workspaceRef;
        if (wakeLanding) pendingWakeLanding = null;
        const landing = p.fresh
          ? model.activeRef === p.workspaceRef ||
            (p.stealFocus === false &&
              model.activeRef === null &&
              !viewed &&
              project !== undefined &&
              !isCollapsed(project))
          : wakeLanding && p.stealFocus !== false;
        if (landing) {
          dispatchDetached({
            type: INTENT_SWITCH_WORKSPACE,
            payload: { workspaceRef: p.workspaceRef },
          });
        }
        scheduleUpdate();
      },
    },
    [EVENT_WORKSPACE_LOADING]: {
      handler: async (event): Promise<void> => {
        const p = event.payload;
        const project = model.projects.get(p.projectRef);
        if (!project) return;
        // Name-guarded: loading also fires for wakes/reopens of existing
        // workspaces, which must not create a duplicate entry.
        const nameLower = p.workspaceName.toLowerCase();
        for (const entry of model.workspaces.values()) {
          if (entry.project === project && entry.workspace.name.toLowerCase() === nameLower) {
            return;
          }
        }
        const ref = makeWorkspaceRef(project.ref, p.workspaceName);
        model.putWorkspace(project, {
          ref,
          name: p.workspaceName,
          title: undefined,
          hibernated: false,
          hibernatedAt: undefined,
          wakeupScript: undefined,
          tags: [],
          url: undefined,
          phase: "creating",
        });
        // Landing in the creating placeholder is the visual confirmation the
        // workspace is being made (activating it also leaves the creation
        // panel, which only shows while nothing is active). A background
        // creation shows the row from the same moment but must not take the
        // view — visibility and focus are separate concerns.
        if (p.stealFocus !== false) {
          model.activeRef = ref;
          expandActiveProject();
        }
        scheduleUpdate();
      },
    },
    [EVENT_WORKSPACE_CREATE_FAILED]: {
      handler: async (event): Promise<void> => {
        const p = event.payload;
        const project = model.projects.get(p.projectRef);
        if (!project) return;
        const workspace = model.findByName(project, p.workspaceName);
        if (!workspace) return;
        if (workspace.phase === "loading") {
          // An existing worktree that would not open keeps its row, with the
          // reason and a Retry.
          workspace.phase = "open-failed";
          workspace.openError = p.error;
          scheduleUpdate();
          return;
        }
        if (workspace.phase !== "creating") return;
        model.removeWorkspace(workspace.ref);
        if (model.activeRef === workspace.ref) model.activeRef = null;
        scheduleUpdate();
      },
    },
    [EVENT_WORKSPACE_WAKE_FAILED]: {
      // A Retry's wake can fail before it reaches workspace:open (which would
      // report workspace:create-failed): the row must not stay loading.
      handler: async (event): Promise<void> => {
        const p = event.payload;
        if (pendingWakeLanding === p.workspaceRef) pendingWakeLanding = null;
        const workspace = model.find(p.workspaceRef)?.workspace;
        if (workspace?.phase !== "loading") return;
        workspace.phase = "open-failed";
        workspace.openError = p.error;
        scheduleUpdate();
      },
    },
    [EVENT_WORKSPACE_DELETED]: {
      handler: async (event): Promise<void> => {
        await agents.events[EVENT_WORKSPACE_DELETED].handler(event);
        const { workspaceRef } = event.payload;
        model.removeWorkspace(workspaceRef);
        deletions.delete(workspaceRef);
        framesReleased.delete(workspaceRef);
        screenshots.delete(workspaceRef);
        // A card about a workspace that is gone has nothing left to point at.
        notifications.closeWorkspace(workspaceRef);
        scheduleUpdate();
      },
    },
    [EVENT_WORKSPACE_DELETION_PROGRESS]: {
      handler: async (event): Promise<void> => {
        const progress = event.payload as DeletionProgress;
        if (progress.completed && !progress.hasErrors) {
          // Auto-clear on successful completion (workspace:deleted removes the row).
          deletions.delete(progress.workspaceRef);
        } else {
          deletions.set(progress.workspaceRef, progress);
        }
        scheduleUpdate();
      },
    },
    [EVENT_WORKSPACE_SWITCHED]: {
      handler: async (event): Promise<void> => {
        const payload = event.payload;
        const ref = payload?.workspaceRef ?? null;
        // Handlers run in module order and an earlier one may await (auto-tagging
        // clears the "new" tag, a git write that takes a second on Windows), so a
        // later switch — deselecting to open the creation panel — can land here
        // first. Applying the older event then would pull the view back to a
        // workspace that is no longer active. The lifecycle module tracks switches
        // in dispatch order, so ask it.
        try {
          const activeNow = await activeWorkspaceRef((intent) => deps.dispatcher.dispatch(intent));
          if (activeNow !== ref) {
            logger.debug("Dropped stale workspace:switched", { key: ref, active: activeNow });
            return;
          }
        } catch (error: unknown) {
          // Nothing to check against: trust the event.
          logger.debug("Active workspace lookup failed", { error: getErrorMessage(error) });
        }
        model.activeRef = ref;
        expandActiveProject();
        scheduleUpdate();
      },
    },
    [EVENT_AGENT_STATUS_UPDATED]: agents.events[EVENT_AGENT_STATUS_UPDATED],
    [EVENT_METADATA_CHANGED]: {
      handler: async (event): Promise<void> => {
        const p = event.payload;
        const workspace = model.find(p.workspaceRef)?.workspace;
        if (!workspace) return;
        // Metadata is interpreted, never stored: only the keys the UI cares
        // about mutate the model (and push); everything else is ignored.
        if (p.key === "hibernated") {
          const hibernating = p.value === "true" && !workspace.hibernated;
          workspace.hibernated = p.value === "true";
          // Flag flips invalidate the cached screenshot (deleted on wake).
          screenshots.delete(p.workspaceRef);
          // A workspace going to sleep folds its project's hibernated list away.
          if (hibernating) {
            const project = model.find(p.workspaceRef)?.project;
            if (project) hibernatedViews.delete(project.ref);
          }
        } else if (p.key === WAKEUP_METADATA_KEY) {
          workspace.wakeupScript = readWakeupScript(p.value);
        } else if (p.key === "hibernated-at") {
          workspace.hibernatedAt = readHibernatedAt(p.value);
        } else if (p.key === "title") {
          // Empty/cleared title reverts the row to the branch name.
          workspace.title = readTitle(p.value);
        } else if (p.key.startsWith(TAGS_METADATA_KEY_PREFIX)) {
          const name = p.key.slice(TAGS_METADATA_KEY_PREFIX.length);
          workspace.tags = workspace.tags.filter((tag) => tag.name !== name);
          if (p.value !== null) {
            // readTags owns the parsing (color JSON, empty-name guard) and
            // leaves out the legacy wakeup tag.
            workspace.tags.push(...readTags({ [p.key]: p.value }));
          }
        } else {
          return;
        }
        scheduleUpdate();
      },
    },
    [EVENT_SHORTCUT_ACTIVE_CHANGED]: {
      handler: async (event): Promise<void> => {
        shortcutActive = event.payload.active;
        scheduleUpdate();
      },
    },
    [EVENT_SHORTCUT_KEY_PRESSED]: {
      handler: async (event): Promise<void> => {
        const { key } = event.payload;
        // Only navigation runs in shortcut mode; the shortcut-module already
        // handles Escape/Alt-release. Validate the key like the old IPC bridge.
        if (isShortcutKey(key)) runShortcutKey(key);
      },
    },
  });

  /**
   * The "prepare-capture" hook on workspace:hibernate: collapse the sidebar out
   * of the hibernation screenshot. Only the visible (active) workspace's iframe
   * is captured, so this is a no-op for background hibernations. The snapshot is
   * pushed immediately (not coalesced) and we wait for the renderer to paint the
   * collapsed sidebar before the "capture" hook runs.
   */
  async function prepareCapture(
    ctx: HookInput<typeof HIBERNATE_WORKSPACE_OPERATION_ID, "prepare-capture">
  ): Promise<HookOutput<PrepareCaptureHookResult>> {
    const { active } = ctx;
    if (!active) return {};
    capturing = true;
    // Flush synchronously so the capturing snapshot reaches the renderer before
    // the paint barrier (scheduleUpdate would coalesce it onto a later tick).
    push();
    await deps.viewManager.waitForUIPaint();
    return {};
  }

  /**
   * The "cleanup-capture" hook on workspace:hibernate: restore the sidebar after
   * the screenshot. Runs in the operation's `finally`, so it clears the flag
   * even if the "capture" hook threw — the sidebar can never stay stuck
   * collapsed.
   */
  async function cleanupCapture(
    ctx: HookInput<typeof HIBERNATE_WORKSPACE_OPERATION_ID, "cleanup-capture">
  ): Promise<HookOutput<CleanupCaptureHookResult>> {
    const { active } = ctx;
    if (!active) return {};
    capturing = false;
    scheduleUpdate();
    return {};
  }

  /**
   * The "confirm" hook on project:close (interactive dispatches only): parks
   * the dispatch on the close confirmation dialog. Checkbox changes round-trip
   * through the backend model (interlock: deleting the repository directory
   * forces remove-all on; withdrawing that deletion withdraws the implied
   * remove-all with it).
   */
  async function confirmClose(
    input: HookInput<typeof CLOSE_PROJECT_OPERATION_ID, "confirm">
  ): Promise<HookOutput<CloseConfirmHookResult>> {
    const isRemote = input.remoteUrl !== undefined;
    const state: CloseConfirmState = { removeAll: false, keepRepo: false, removeRepo: false };
    const projectPath = input.projectPath.toString();
    const buildConfig = (): DialogConfig =>
      buildCloseConfirmConfig(state, input.workspaces.length, input.remoteUrl, projectPath);

    const handle = dialogs.open(buildConfig());
    const unsubscribe = handle.onChange((change) => {
      if (change.fieldId === "remove-all") {
        state.removeAll = change.data["remove-all"] === "true";
      } else if (change.fieldId === "keep-repo") {
        state.keepRepo = change.data["keep-repo"] === "true";
        if (state.keepRepo) {
          // Keeping the repository withdraws the implied remove-all.
          state.removeAll = false;
        }
      } else if (change.fieldId === "remove-repo") {
        state.removeRepo = change.data["remove-repo"] === "true";
        if (!state.removeRepo) {
          // Same withdrawal, positive polarity: unchecking the deletion takes
          // the remove-all it forced on back with it.
          state.removeAll = false;
        }
      }
      handle.update(buildConfig());
    });

    try {
      const event = await handle.nextEvent();
      if (event.kind !== "dismiss" && event.actionId === "close") {
        const shouldDeleteRepo = isRemote ? !state.keepRepo : state.removeRepo;
        return {
          result: {
            removeAll: state.removeAll || shouldDeleteRepo,
            removeLocalRepo: shouldDeleteRepo,
          },
        };
      }
      // Cancel button or Escape.
      return { result: { canceled: true } };
    } finally {
      unsubscribe();
      handle.close();
    }
  }

  return {
    name: "presentation",
    dialog: (config: DialogConfig, options?: DialogOpenOptions): DialogHandle =>
      dialogs.open(config, options),
    isModalOpen: (): boolean => dialogs.isModalOpen(),
    deletionProgress: (workspaceRef: WorkspaceRef): DeletionProgress | undefined =>
      deletions.get(workspaceRef),
    reloadFrame,
    trackRunningHook: (hook) => runningHooks.track(hook),
    cancelRunningHooks: (workspaceRef) => runningHooks.cancelFor(workspaceRef),
    events,
    interceptors: [
      suppressBackgroundFocus,
      trackWakeLanding,
      keepEditedCreationForm,
      startup.interceptor,
    ],
    hooks: defineHooks({
      [APP_START_OPERATION_ID]: {
        init: {
          // Seed + track the OS theme as soon as the UI is ready (the same gate
          // the old theme-module used), so every snapshot — including the
          // startup screens — carries the right theme. Theme now rides in the
          // ui:state snapshot; there is no separate theme channel.
          requires: { "ui-ready": ANY_VALUE },
          handler: async (): Promise<void> => {
            theme = deps.windowManager.getTheme();
            themeUnsubscribe = deps.windowManager.onThemeChange((next) => {
              theme = next;
              scheduleUpdate();
            });
            windowFocused = deps.windowManager.isFocused();
            focusUnsubscribe = deps.windowManager.onFocusChange((focused) => {
              windowFocused = focused;
              scheduleUpdate();
            });
            scheduleUpdate();
          },
        },
        ...startup.appStartHooks,
      },
      ...createNotificationHooks(
        notifications,
        createModalEdges(deps.dispatcher, logger, "sidebar")
      ),
      [SETUP_OPERATION_ID]: startup.setupHooks,
      [CLOSE_PROJECT_OPERATION_ID]: {
        confirm: { handler: confirmClose },
      },
      [DELETE_WORKSPACE_OPERATION_ID]: {
        // Release the workspace's IDE frame — but only after the agent has been
        // stopped. `requires` holds this until the api-server handler that asks
        // the agent to exit is done, so the iframe (and with it the IDE client
        // connection the request travels over) survives until that has either
        // succeeded or hit its own timeout.
        //
        // Dropping the frame earlier is what orphans the agent: the disconnect
        // disposes the extension host, whose terminals then report "closed"
        // while the pty — and the agent under it — keeps running with the
        // workspace as its CWD, so the worktree removal cannot delete it.
        shutdown: {
          requires: { [CAPABILITY_AGENT_STOPPED]: ANY_VALUE },
          handler: async (ctx): Promise<HookOutput<ShutdownHookResult>> => {
            const { workspaceRef } = ctx;
            framesReleased.add(workspaceRef);
            scheduleUpdate();
            return { result: {} };
          },
        },
      },
      [SWITCH_WORKSPACE_OPERATION_ID]: {
        // Leaving a placeholder for the workspace that is still active main-side
        // (where the creation started) is a no-op switch with no event, so the
        // view moves here.
        activate: {
          handler: async (ctx): Promise<HookOutput<SwitchWorkspaceHookResult>> => {
            pendingWakeLanding = null;
            if (model.active()?.workspace.phase === "creating" && ctx.workspaceRef !== null) {
              model.activeRef = ctx.workspaceRef;
              scheduleUpdate();
            }
            return { result: {} };
          },
        },
        // Auto-select never lands in a collapsed project.
        "find-candidates": {
          handler: async (): Promise<HookOutput<FindCandidatesHookResult>> => ({
            result: {
              excludedProjects: [...model.projects.values()]
                .filter(isCollapsed)
                .map((project) => project.ref),
            },
          }),
        },
      },
      [HIBERNATE_WORKSPACE_OPERATION_ID]: {
        // Collapse the sidebar out of the hibernation screenshot and restore it
        // after (cleanup runs in the operation's finally).
        "prepare-capture": { handler: prepareCapture },
        "cleanup-capture": { handler: cleanupCapture },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async (): Promise<void> => {
            // Close the snapshot stream first so the dialog close below (and any
            // late domain event) can't push another snapshot during teardown.
            connected = false;
            // Keep the system dialog closed for the rest of the process life,
            // and reject any parked startup promises so app:start / app:setup
            // unwind rather than hang.
            startup.shutdown();
            unsubscribeFromUI();
            if (themeUnsubscribe) {
              themeUnsubscribe();
              themeUnsubscribe = null;
            }
            focusUnsubscribe?.();
            focusUnsubscribe = null;
            unsubscribeProcessSummaries();
          },
        },
      },
    }),
  };
}
