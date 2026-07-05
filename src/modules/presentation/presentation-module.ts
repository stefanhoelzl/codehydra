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

import type { IntentModule, EventDeclarations } from "../../intents/lib/module";
import type { DomainEvent } from "../../intents/lib/types";
import type { HookContext, HookOutput } from "../../intents/lib/operation";
import { ANY_VALUE } from "../../intents/lib/operation";
import type { IDispatcher } from "../../intents/lib/dispatcher";
import type { Logging, LoggerName, LogContext } from "../../boundaries/platform/logging";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { PathProvider } from "../../boundaries/platform/path-provider";
import type { PersistedAccessor } from "../../boundaries/platform/store-definition";
import type { IViewManager } from "../../boundaries/shell/view-manager.interface";
import type { Theme } from "../../boundaries/shell/window-manager";
import type { Unsubscribe } from "../../shared/api/interfaces";
import type { AgentStatus, DeletionProgress, WorkspaceTag } from "../../shared/api/types";
import { extractTags, TAGS_METADATA_KEY_PREFIX } from "../../shared/api/types";
import {
  APP_SHUTDOWN_OPERATION_ID,
  INTENT_APP_SHUTDOWN,
  type AppShutdownIntent,
} from "../../intents/app-shutdown";
import { EVENT_APP_STARTED, INTENT_APP_READY, type AppReadyIntent } from "../../intents/app-ready";
import { APP_START_OPERATION_ID, type ShowUIHookResult } from "../../intents/app-start";
import {
  SETUP_OPERATION_ID,
  EVENT_SETUP_PROGRESS,
  EVENT_SETUP_ERROR,
  type AgentSelectionHookContext,
  type SetupProgressEvent,
  type SetupErrorEvent,
} from "../../intents/setup";
import type { LifecycleAgentType } from "../../shared/ipc";
import { EVENT_PROJECT_OPENED, type ProjectOpenedEvent } from "../../intents/open-project";
import {
  EVENT_PROJECT_CLOSED,
  INTENT_CLOSE_PROJECT,
  CLOSE_PROJECT_OPERATION_ID,
  type ProjectClosedEvent,
  type CloseProjectIntent,
  type CloseConfirmHookInput,
  type CloseConfirmHookResult,
} from "../../intents/close-project";
import {
  EVENT_WORKSPACE_CREATED,
  EVENT_WORKSPACE_LOADING,
  EVENT_WORKSPACE_CREATE_FAILED,
  type WorkspaceCreatedEvent,
  type WorkspaceLoadingEvent,
  type WorkspaceCreateFailedEvent,
} from "../../intents/open-workspace";
import {
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETION_PROGRESS,
  INTENT_DELETE_WORKSPACE,
  type DeleteWorkspaceIntent,
  type WorkspaceDeletedEvent,
  type WorkspaceDeletionProgressEvent,
} from "../../intents/delete-workspace";
import {
  EVENT_WORKSPACE_SWITCHED,
  INTENT_SWITCH_WORKSPACE,
  type WorkspaceSwitchedEvent,
  type SwitchWorkspaceIntent,
} from "../../intents/switch-workspace";
import {
  EVENT_AGENT_STATUS_UPDATED,
  type AgentStatusUpdatedEvent,
} from "../../intents/update-agent-status";
import { EVENT_METADATA_CHANGED, type MetadataChangedEvent } from "../../intents/set-metadata";
import {
  EVENT_SHORTCUT_ACTIVE_CHANGED,
  type ShortcutActiveChangedEvent,
} from "../../intents/set-shortcut-active";
import {
  EVENT_SHORTCUT_KEY_PRESSED,
  type ShortcutKeyPressedEvent,
} from "../../intents/shortcut-key";
import {
  INTENT_HIBERNATE_WORKSPACE,
  HIBERNATE_WORKSPACE_OPERATION_ID,
  type HibernateWorkspaceIntent,
  type HibernatePipelineHookInput,
  type PrepareCaptureHookResult,
  type CleanupCaptureHookResult,
} from "../../intents/hibernate-workspace";
import { INTENT_WAKE_WORKSPACE, type WakeWorkspaceIntent } from "../../intents/wake-workspace";
import { isShortcutKey, jumpKeyToIndex, type JumpKey } from "../../shared/shortcuts";
import type { UIMode } from "../../shared/ipc";
import { ApiIpcChannels } from "../../shared/ipc";
import type {
  DialogActionEvent,
  DialogConfig,
  DialogSection,
  DialogKind,
  ProgressItem,
} from "../../shared/dialog-types";
import { uiEventSchema } from "../../shared/ui-event";
import {
  clampSidebarWidthMin,
  compareDisplayNames,
  type SidebarLabelScroll,
  type UiDeletionProgress,
  type UiMainView,
  type UiProjectRow,
  type UiState,
  type UiWorkspaceRow,
} from "../../shared/ui-state";
import type { Config } from "../../boundaries/platform/config";
import { storeEnum } from "../../boundaries/platform/store-definition";
import { buildScreenshotPath } from "../hibernation-screenshot-module";
import {
  DialogManager,
  NotificationManager,
  type DialogHandle,
  type NotificationHandle,
} from "./sessions";
import type { NotificationConfig } from "../../shared/notification-types";
import { getErrorMessage } from "../../shared/error-utils";

export interface PresentationModuleDeps {
  readonly loggingService: Pick<Logging, "createLogger">;
  readonly viewManager: Pick<IViewManager, "sendToUI" | "onFromUI" | "waitForUIPaint">;
  readonly windowManager: {
    getTheme(): Theme;
    onThemeChange(callback: (theme: Theme) => void): Unsubscribe;
  };
  readonly fileSystem: Pick<FileSystemBoundary, "readFileBuffer">;
  readonly pathProvider: PathProvider;
  readonly dispatcher: Pick<IDispatcher, "dispatch">;
  /**
   * Persisted expanded-sidebar width (px). Read into every snapshot's sidebar
   * region and written when the renderer emits a `resize-sidebar` drag result.
   */
  readonly sidebarWidthConfig: Pick<PersistedAccessor<number>, "get" | "set">;
  readonly configService: Pick<Config, "register">;
  /**
   * Called when the renderer emits the `open-settings` ui event (the sidebar
   * gear). Wired in the composition root to the settings module's openSettings;
   * the presenter itself stays agnostic of the settings dialog.
   */
  readonly onOpenSettings?: () => void;
}

/** Allowed values for the `sidebar.label-scroll` config key. */
const LABEL_SCROLL_VALUES = ["always", "hover", "off"] as const;

/**
 * The UI presenter: an IntentModule that also exposes the imperative
 * dialog/notification command surface for any module to inject. It is the sole
 * owner of ui:state and of the UI-view IPC (both directions, via ViewManager),
 * and privately owns the Dialog/Notification managers whose state it folds into
 * the snapshot.
 */
export interface UiPresenter extends IntentModule {
  /** Open a dialog (modal, modeless, or panel — see DialogKind). Returns a handle. */
  dialog(config: DialogConfig, options?: { kind?: DialogKind }): DialogHandle;
  /** Open a sidebar notification. Returns a handle. */
  notification(config: NotificationConfig): NotificationHandle;
  /** True while a blocking modal dialog (kind === "modal") is open (the shortcut-module Alt+X guard). */
  isModalOpen(): boolean;
  /**
   * The current full deletion progress for a workspace path, or undefined when
   * it is not deleting. The presenter is the single owner of deletion progress
   * (it tracks it for row status); the deletion-dialog module reads it here for
   * its modal and retry/dismiss dispatch inputs rather than tracking its own.
   */
  deletionProgress(workspacePath: string): DeletionProgress | undefined;
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
  /**
   * User-given display title (metadata `title`); undefined when unset, so the
   * row falls back to `name`. Display-only — `name` stays the identity.
   */
  title: string | undefined;
  /** Real worktree path; null while the workspace is still being created. */
  path: string | null;
  hibernated: boolean;
  tags: WorkspaceTag[];
  url: string | undefined;
  creating: boolean;
}

/**
 * Interpret a raw metadata `title` into the model field: trim, and treat an
 * empty string as unset (undefined) so an emptied title reverts to the branch.
 */
function readTitle(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Interpret a workspace's domain metadata into the semantic model fields. */
function fromMetadata(
  metadata: Readonly<Record<string, string>>
): Pick<WorkspaceModel, "hibernated" | "tags" | "title"> {
  return {
    hibernated: metadata["hibernated"] === "true",
    tags: extractTags(metadata),
    title: readTitle(metadata["title"]),
  };
}

/**
 * Distill the domain DeletionProgress into the render-ready row field: keep
 * only what a renderer shows (per-operation display status, completion/error
 * flags, blocking-process count) — never the WorkspacePath/ProjectId/PIDs.
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

  return { sections };
}

export function createPresentationModule(deps: PresentationModuleDeps): UiPresenter {
  const logger = deps.loggingService.createLogger("presenter");

  // Sidebar row labels can overflow the narrow rail; this key picks how the
  // custom-title / branch / tags lines scroll when they do. Read (via the
  // accessor) at snapshot-build time and shipped in every ui:state push.
  const labelScrollConfig = deps.configService.register<SidebarLabelScroll>(
    "sidebar.label-scroll",
    {
      default: "hover",
      description: "How overflowing sidebar row labels scroll: always|hover|off",
      applies: "live",
      ...storeEnum(LABEL_SCROLL_VALUES),
    }
  );

  // The presenter privately owns the dialog/notification registries. They hold
  // session state and hand out handles; every mutation calls scheduleUpdate so
  // their getSnapshot() is folded into the next ui:state push. (scheduleUpdate
  // is a hoisted function declaration below.)
  const dialogs = new DialogManager(scheduleUpdate, logger);
  const notifications = new NotificationManager(scheduleUpdate, logger);

  // ---------------------------------------------------------------------------
  // State (mirrors the renderer stores' semantics)
  // ---------------------------------------------------------------------------

  /** Keyed by projectId; insertion-ordered. */
  const projects = new Map<string, ProjectModel>();
  /** Agent status keyed by workspace path. */
  const agentStatuses = new Map<string, AgentStatus>();
  /**
   * Deletion lifecycle keyed by workspace path (absent = not deleting). The
   * single source of truth for deletion progress: the row's render-ready
   * `deletionProgress` + `status` derive from it, and the deletion-dialog
   * module reads it (via the `deletionProgress` accessor) for its modal +
   * retry/dismiss dispatch inputs instead of tracking its own copy. Holds the
   * full domain `DeletionProgress` because the modal needs fields the
   * render-ready row view omits (blocking-process pids, keepBranch).
   */
  const deletions = new Map<string, DeletionProgress>();
  /** Hibernation screenshot data URLs keyed by workspace key (null = missing). */
  const screenshots = new Map<string, string | null>();
  const screenshotLoads = new Set<string>();
  let activeKey: string | null = null;
  let theme: Theme = "dark";
  /**
   * The snapshot stream gate. Set true on the `ui-connected` handshake (App
   * mount, during app:start). Pushes are gated on this — the view-model is
   * maintained from genesis, but nothing leaves main until the renderer has
   * subscribed. The genesis snapshot is flushed immediately on connect.
   */
  let connected = false;
  let pushScheduled = false;
  let themeUnsubscribe: Unsubscribe | null = null;

  // ---------------------------------------------------------------------------
  // Startup flow view-model (boot splash, first-run setup, agent-selection,
  // workspace loading). Everything the user sees before app:started — and the
  // mid-session "workspace still creating" overlay — is a single modal dialog
  // (the "system dialog") layered over a blank `main: { kind: "starting" }`
  // base; `reconcileSystemDialog()` (run inside push) projects it from state.
  // ---------------------------------------------------------------------------

  /**
   * Startup phase. "starting" is the genesis state (boot splash); "setup" /
   * "agent-selection" are pushed by the app:setup hooks; "running" is reached
   * once app:start's `start` hook fires (app:ready dispatched) and stays until
   * app:started, after which the normal main logic owns the view.
   */
  type StartupPhase = "starting" | "setup" | "agent-selection" | "running" | "done";
  let startupPhase: StartupPhase = "starting";

  /** A first-run setup progress row, accumulated from setup:progress events. */
  interface SetupRow {
    readonly id: string;
    readonly label: string;
    readonly status: "pending" | "running" | "done" | "error";
    readonly message?: string;
    readonly progress?: number;
  }

  const SETUP_ROW_LABELS: Record<string, string> = {
    vscode: "VSCode",
    agent: "Agent",
    setup: "Setup",
  };
  const SETUP_ROW_IDS = ["vscode", "agent", "setup"] as const;
  /** Accumulated setup row state, keyed by row id (persists across progress). */
  const setupRows = new Map<string, SetupRow>();
  let setupError: { message: string } | undefined;

  /** Reset the three setup rows to pending (entering the setup phase). */
  function resetSetupRows(): void {
    setupRows.clear();
    setupError = undefined;
    for (const id of SETUP_ROW_IDS) {
      setupRows.set(id, { id, label: SETUP_ROW_LABELS[id] ?? id, status: "pending" });
    }
  }

  /** Current setup rows in canonical (vscode, agent, setup) order. */
  function setupRowList(): SetupRow[] {
    return SETUP_ROW_IDS.map(
      (id) => setupRows.get(id) ?? { id, label: SETUP_ROW_LABELS[id] ?? id, status: "pending" }
    );
  }

  /** Available agents for the picker (set by the agent-selection hook). */
  let agentOptions: AgentSelectionHookContext["availableAgents"] = [];
  /** Resolve/reject the parked agent-selection hook (set while awaiting a pick).
   *  A pick resolves it; app:shutdown rejects it so app:setup unwinds WITHOUT
   *  reaching save-agent (nothing persisted; next launch re-prompts). */
  let agentSelectionResolve: ((agent: LifecycleAgentType) => void) | null = null;
  let agentSelectionReject: ((reason: Error) => void) | null = null;
  /** Resolve/reject app:start's waitForRetry (set while awaiting a setup retry).
   *  The Retry button resolves it; app:shutdown rejects it to unwind app:start. */
  let retryResolve: (() => void) | null = null;
  let retryReject: ((reason: Error) => void) | null = null;

  /**
   * The single modal dialog projecting the startup surfaces + the mid-session
   * loading overlay. Reconciled from state in push(); its action events (agent
   * pick, setup Retry/Quit) route here via `handleSystemAction`.
   */
  let systemDialog: DialogHandle | null = null;
  /** JSON of the last-applied system-dialog config (null = closed). Guards
   *  reconcile against redundant updates (and thus push loops). */
  let systemDialogConfigJson: string | null = null;
  /** True only while push() is reconciling: suppresses the dialog mutations'
   *  own scheduleUpdate (the in-flight push already carries them). */
  let inPush = false;
  /** Set once app:shutdown starts: the system dialog stays closed thereafter. */
  let shuttingDown = false;

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
    const progress = workspace.path === null ? undefined : deletions.get(workspace.path);
    if (progress) return progress.completed && progress.hasErrors ? "delete-failed" : "deleting";
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
    const progress = workspace.path === null ? undefined : deletions.get(workspace.path);
    return {
      key,
      name: workspace.name,
      ...(workspace.title !== undefined && { title: workspace.title }),
      status: rowStatus(workspace),
      hibernated: workspace.hibernated,
      agent:
        (workspace.path === null ? undefined : agentStatuses.get(workspace.path)) ?? AGENT_NONE,
      // Copy: the model array mutates on tag changes; snapshots are immutable values.
      tags: [...workspace.tags],
      active: key === activeKey,
      // Derive the render-ready row view from the full tracked progress.
      ...(progress && { deletionProgress: toUiDeletionProgress(progress) }),
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
    // The startup flow (every phase before app:started) shows nothing in main:
    // a blank base under the reconciled system dialog. `starting` is the single
    // marker the renderer reads to keep MainView unmounted (showMain stays
    // false until main.kind flips to a running kind at app:started).
    if (startupPhase !== "done") return { kind: "starting" };

    // Normal main logic (startupPhase === "done").
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
    // A still-creating active workspace has no mounted frame yet (its key is
    // absent from `frames`), so the workspace area is blank behind the
    // reconciled mid-session loading dialog until workspace:created arrives.
    return { kind: "workspace", frameKey: activeKey };
  }

  /**
   * Compute the single UI mode. Priority shortcut > dialog > hover > workspace.
   * The creation panel (no active workspace) maps to hover-level: UI on top but
   * Alt+X still works.
   */
  function buildMode(main: UiMainView): UIMode {
    // The startup surfaces and the mid-session loading overlay are modal system
    // dialogs now, so isModalOpen() already yields "dialog" for them — no
    // startup special-case needed.
    if (shortcutActive) return "shortcut";
    if (dialogs.isModalOpen()) return "dialog";
    if (main.kind === "creation" || hoverRegion === "sidebar") return "hover";
    return "workspace";
  }

  // ---------------------------------------------------------------------------
  // System dialog (startup surfaces + mid-session loading)
  //
  // One modal dialog projects the whole pre-`app:started` flow and the
  // still-creating-workspace overlay. It is reconciled from state in push():
  // computeSystemDialogConfig() maps the current phase (or mid-session loading)
  // to a DialogConfig, or null when nothing should show. reconcileSystemDialog()
  // opens/updates/closes the handle to match, guarded by a JSON compare so an
  // unchanged config never re-pushes.
  // ---------------------------------------------------------------------------

  /** A centered spinner + label (boot splash / loading), via a spinner row. */
  function spinnerConfig(label: string): DialogConfig {
    return {
      sections: [
        { type: "progress", style: "spinner", items: [{ id: "status", label, status: "running" }] },
      ],
    };
  }

  /** The first-run setup surface: progress rows, plus Retry/Quit on error. */
  function setupConfig(): DialogConfig {
    const items: ProgressItem[] = setupRowList().map((row) => ({
      id: row.id,
      label: row.label,
      status: row.status,
      ...(row.message !== undefined && { message: row.message }),
      ...(row.progress !== undefined && { progress: row.progress }),
    }));
    const sections: DialogSection[] = [
      { type: "text", content: "Setting up CodeHydra", style: "heading" },
      { type: "text", content: "This is only required on first startup.", style: "subtitle" },
      { type: "progress", style: "spinner", items },
    ];
    if (setupError !== undefined) {
      sections.push({ type: "text", content: setupError.message, style: "error" });
      // Retry is primary (Enter activates it); Quit is a plain button; no
      // cancel-role button, so Escape is a no-op (setup is mandatory).
      sections.push({
        type: "group",
        items: [
          // autofocus for the same reason as the agent radio: the persistent
          // dialog doesn't remount when the error + buttons appear.
          { type: "button", id: "retry", label: "Retry", variant: "primary", autofocus: true },
          { type: "button", id: "quit", label: "Quit", variant: "secondary" },
        ],
      });
    }
    return { sections };
  }

  /**
   * The agent picker: a radio group (defaulting to the first option, focused on
   * mount by the form) + a primary Continue button. Arrow keys move the
   * selection, Enter / Ctrl+Enter activate Continue; no cancel button, so
   * Escape is a no-op (selection is mandatory on first run).
   */
  function agentConfig(): DialogConfig {
    return {
      sections: [
        { type: "text", content: "Choose Agent", style: "heading" },
        {
          type: "radio",
          id: "agent",
          // autofocus: the system dialog is one persistent handle updated across
          // phases, so the Form never remounts — the focus-follow moves focus
          // onto the selected radio card when this config replaces the spinner.
          autofocus: true,
          options: agentOptions.map((a) => ({ id: a.agent, label: a.label, icon: a.icon })),
        },
        {
          type: "group",
          items: [{ type: "button", id: "continue", label: "Continue", variant: "primary" }],
        },
      ],
    };
  }

  /** The desired system-dialog config for the current state, or null for none. */
  function computeSystemDialogConfig(): DialogConfig | null {
    if (shuttingDown) return null;
    switch (startupPhase) {
      case "starting":
        return spinnerConfig("CodeHydra is starting…");
      case "setup":
        return setupConfig();
      case "agent-selection":
        return agentConfig();
      case "running":
        return spinnerConfig("Loading workspace...");
      case "done": {
        // Mid-session: a still-creating active workspace has no frame yet.
        if (activeKey === null) return null;
        const active = findByKey(activeKey);
        return active?.workspace.creating ? spinnerConfig("Loading workspace...") : null;
      }
    }
  }

  /** Route the system dialog's action events (agent pick, Retry, Quit). */
  function handleSystemAction(event: DialogActionEvent): void {
    switch (event.actionId) {
      case "continue": {
        const agent = event.data?.["agent"];
        if (agentSelectionResolve && agent) {
          logger.info("Agent selected", { agent });
          agentSelectionResolve(agent as LifecycleAgentType);
          agentSelectionResolve = null;
          agentSelectionReject = null;
        }
        return;
      }
      case "retry":
        if (retryResolve) {
          retryResolve();
          retryResolve = null;
          retryReject = null;
        }
        return;
      case "quit": {
        const handle = deps.dispatcher.dispatch({
          type: INTENT_APP_SHUTDOWN,
          payload: {},
        } as AppShutdownIntent);
        void handle.catch((error: unknown) => {
          logger.debug("app:shutdown dispatch rejected", { error: getErrorMessage(error) });
        });
        return;
      }
    }
  }

  /**
   * Reconcile the system dialog with the current state. Called at the top of
   * push() (inPush suppresses the dialog mutations' own scheduleUpdate — the
   * in-flight push already reflects them). The JSON guard makes an unchanged
   * config a no-op, so this never loops.
   */
  function reconcileSystemDialog(): void {
    const config = computeSystemDialogConfig();
    const json = config === null ? null : JSON.stringify(config);
    if (json === systemDialogConfigJson) return;
    systemDialogConfigJson = json;
    if (config === null) {
      systemDialog?.close();
      systemDialog = null;
      return;
    }
    if (systemDialog) {
      systemDialog.update(config);
    } else {
      systemDialog = dialogs.open(config, { kind: "modal" });
      systemDialog.onEvent(handleSystemAction);
    }
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
    return {
      // Clamp the stored width to the shared minimum so a hand-edited
      // config.json below the floor still yields a sane snapshot; the renderer
      // additionally clamps to its window-relative maximum.
      sidebar: {
        projects: projectRows,
        width: clampSidebarWidthMin(deps.sidebarWidthConfig.get()),
      },
      frames,
      main,
      theme,
      labelScroll: labelScrollConfig.get(),
      mode: buildMode(main),
      capturing,
      dialogs: dialogs.getSnapshot(),
      notifications: notifications.getSnapshot(),
    };
  }

  function scheduleUpdate(): void {
    // inPush: reconcileSystemDialog (running inside push) mutates the dialog
    // registry, which calls this — the in-flight push already carries the
    // change, so don't schedule a redundant follow-up.
    if (!connected || pushScheduled || inPush) return;
    pushScheduled = true;
    queueMicrotask(() => {
      pushScheduled = false;
      push();
    });
  }

  function push(): void {
    // Project the startup/loading system dialog from state before snapshotting,
    // so this push carries the reconciled dialog (and mode reads isModalOpen()).
    inPush = true;
    reconcileSystemDialog();
    inPush = false;
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

  const listener = (...args: unknown[]): void => {
    const result = uiEventSchema.safeParse(args[0]);
    if (!result.success) {
      logger.warn("Dropped invalid ui event", {
        issue: result.error.issues[0]?.message ?? "unknown",
      });
      return;
    }
    const event = result.data;
    if (event.kind === "ui-connected") {
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
    if (event.kind === "open-settings") {
      deps.onOpenSettings?.();
      return;
    }
    if (event.kind === "resize-sidebar") {
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
    if (event.kind === "dialog-action") {
      dialogs.routeEvent({
        kind: "action",
        dialogId: event.dialogId,
        actionId: event.actionId,
        ...(event.data !== undefined && { data: event.data }),
      });
      return;
    }
    if (event.kind === "dialog-change") {
      dialogs.routeEvent({
        kind: "change",
        dialogId: event.dialogId,
        fieldId: event.fieldId,
        data: event.data,
      });
      return;
    }
    if (event.kind === "dialog-dismiss") {
      dialogs.routeEvent({ kind: "dismiss", dialogId: event.dialogId });
      return;
    }
    if (event.kind === "notification-event") {
      notifications.routeEvent({
        notificationId: event.notificationId,
        actionId: event.actionId,
      });
      return;
    }
    if (event.kind === "close-project") {
      const project = projects.get(event.projectId);
      if (!project) {
        logger.warn("Dropped close-project for unknown project", { projectId: event.projectId });
        return;
      }
      dispatchDetached({
        type: INTENT_CLOSE_PROJECT,
        payload: { projectPath: project.path, interactive: true },
      });
    }
  };

  const unsubscribeFromUI = deps.viewManager.onFromUI(ApiIpcChannels.UI_EVENT, listener);

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
          title: undefined,
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
          deletions.set(progress.workspacePath, progress);
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
        } else if (p.key === "title") {
          // Empty/cleared title reverts the row to the branch name.
          workspace.title = readTitle(p.value);
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
    [EVENT_SETUP_PROGRESS]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const row = (event as SetupProgressEvent).payload;
        // Map SetupRowStatus ("failed") → SetupRow status ("error").
        const status: SetupRow["status"] = row.status === "failed" ? "error" : row.status;
        setupRows.set(row.id, {
          id: row.id,
          label: SETUP_ROW_LABELS[row.id] ?? row.id,
          status,
          ...(row.message !== undefined && { message: row.message }),
          ...(row.progress !== undefined && { progress: row.progress }),
        });
        scheduleUpdate();
      },
    },
    [EVENT_SETUP_ERROR]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const { message } = (event as SetupErrorEvent).payload;
        setupError = { message };
        scheduleUpdate();
      },
    },
    [EVENT_APP_STARTED]: {
      handler: async (): Promise<void> => {
        // Startup is over: hand the main view back to the normal logic. Theme
        // is already seeded + tracked from the app:start `init` hook (so the
        // startup screens carry the right theme), nothing to do here for it.
        startupPhase = "done";
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
   * The "prepare-capture" hook on workspace:hibernate: collapse the sidebar out
   * of the hibernation screenshot. Only the visible (active) workspace's iframe
   * is captured, so this is a no-op for background hibernations. The snapshot is
   * pushed immediately (not coalesced) and we wait for the renderer to paint the
   * collapsed sidebar before the "capture" hook runs.
   */
  async function prepareCapture(ctx: HookContext): Promise<HookOutput<PrepareCaptureHookResult>> {
    const { active } = ctx as HibernatePipelineHookInput;
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
  async function cleanupCapture(ctx: HookContext): Promise<HookOutput<CleanupCaptureHookResult>> {
    const { active } = ctx as HibernatePipelineHookInput;
    if (!active) return {};
    capturing = false;
    scheduleUpdate();
    return {};
  }

  /**
   * The "confirm" hook on project:close (interactive dispatches only): parks
   * the dispatch on the close confirmation dialog. Checkbox changes round-trip
   * through the backend model (interlock: keeping the cloned repository
   * unchecks remove-all; deleting it forces remove-all on).
   */
  async function confirmClose(ctx: HookContext): Promise<HookOutput<CloseConfirmHookResult>> {
    const input = ctx as CloseConfirmHookInput;
    const isRemote = input.remoteUrl !== undefined;
    const state: CloseConfirmState = { removeAll: false, keepRepo: false };
    const buildConfig = (): DialogConfig =>
      buildCloseConfirmConfig(state, input.workspaces.length, input.remoteUrl);

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
      }
      handle.update(buildConfig());
    });

    try {
      const event = await handle.nextEvent();
      if (event.kind !== "dismiss" && event.actionId === "close") {
        const shouldDeleteRepo = isRemote && !state.keepRepo;
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

  // ---------------------------------------------------------------------------
  // Startup hooks: each just sets the phase + schedules a push; the system
  // dialog is reconciled from that phase in push() (reconcileSystemDialog).
  // ---------------------------------------------------------------------------

  /**
   * app:start `show-ui`: set the boot-splash phase and hand app:start the
   * waitForRetry hook it needs for the setup retry loop. The promise resolves
   * when the user clicks Retry (a system-dialog action); app:shutdown rejects
   * it so a quit-during-retry unwinds app:start instead of hanging.
   */
  async function appStartShowUi(): Promise<HookOutput<ShowUIHookResult>> {
    startupPhase = "starting";
    scheduleUpdate();
    return {
      result: {
        waitForRetry: () =>
          new Promise<void>((resolve, reject) => {
            retryResolve = resolve;
            retryReject = reject;
          }),
      },
    };
  }

  /**
   * app:start `start`: dispatch app:ready (load projects → app:started). Gated
   * on code-server being up (mirrors view-module's old start hook ordering).
   * The "running" phase shows the unified loading screen until app:started.
   * Fire-and-forget: app:ready is awaited internally by the dispatcher, but the
   * hook must not block startup on the projects finishing — the snapshot stream
   * carries the result.
   */
  async function appStartStart(): Promise<void> {
    startupPhase = "running";
    scheduleUpdate();
    const handle = deps.dispatcher.dispatch({
      type: INTENT_APP_READY,
      payload: {},
    } as AppReadyIntent);
    void handle.catch((error: unknown) => {
      logger.debug("app:ready dispatch rejected", { error: getErrorMessage(error) });
    });
  }

  /** app:setup `show-ui`: enter the setup phase with fresh pending rows. */
  async function setupShowUi(): Promise<void> {
    startupPhase = "setup";
    resetSetupRows();
    scheduleUpdate();
  }

  /**
   * app:setup `agent-selection`: show the picker (a radio system dialog) and
   * park until the user clicks Continue, which arrives as a system-dialog
   * action and resolves the parked promise with the chosen agent (returned as
   * the agent-selection hook result to app:setup). app:shutdown REJECTS the promise
   * so a quit-during-selection throws here — app:setup unwinds without reaching
   * save-agent, so no agent is persisted and the next launch re-prompts.
   */
  async function setupAgentSelection(ctx: HookContext): Promise<HookOutput<LifecycleAgentType>> {
    const { availableAgents } = ctx as AgentSelectionHookContext;
    agentOptions = availableAgents;
    startupPhase = "agent-selection";
    scheduleUpdate();

    const agent = await new Promise<LifecycleAgentType>((resolve, reject) => {
      agentSelectionResolve = resolve;
      agentSelectionReject = reject;
    });
    return { result: agent };
  }

  /** app:setup `hide-ui`: return to the boot-splash phase. */
  async function setupHideUi(): Promise<void> {
    startupPhase = "starting";
    scheduleUpdate();
  }

  return {
    name: "presentation",
    dialog: (config: DialogConfig, options?: { kind?: DialogKind }): DialogHandle =>
      dialogs.open(config, options),
    notification: (config: NotificationConfig): NotificationHandle => notifications.open(config),
    isModalOpen: (): boolean => dialogs.isModalOpen(),
    deletionProgress: (workspacePath: string): DeletionProgress | undefined =>
      deletions.get(workspacePath),
    events,
    hooks: {
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
            scheduleUpdate();
          },
        },
        "show-ui": { handler: appStartShowUi },
        start: {
          // Gate on code-server: app:ready dispatches project:open, whose
          // workspace URLs must be servable when the renderer mounts iframes.
          requires: { codeServerPort: ANY_VALUE },
          handler: appStartStart,
        },
      },
      [SETUP_OPERATION_ID]: {
        "show-ui": { handler: setupShowUi },
        "agent-selection": {
          handler: setupAgentSelection,
        },
        "hide-ui": { handler: setupHideUi },
      },
      [CLOSE_PROJECT_OPERATION_ID]: {
        confirm: { handler: confirmClose },
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
            // Keep the system dialog closed for the rest of the process life,
            // and reject any parked startup promises so app:setup / app:start
            // unwind rather than hang. Rejecting the agent-selection promise
            // (rather than resolving a default) is deliberate: a quit-mid-pick
            // must NOT persist an agent the user never chose.
            shuttingDown = true;
            // Close the snapshot stream first so the dialog close below (and any
            // late domain event) can't push another snapshot during teardown.
            connected = false;
            if (agentSelectionReject) {
              agentSelectionReject(new Error("app shutting down during agent selection"));
              agentSelectionResolve = null;
              agentSelectionReject = null;
            }
            if (retryReject) {
              retryReject(new Error("app shutting down during setup retry"));
              retryResolve = null;
              retryReject = null;
            }
            systemDialog?.close();
            systemDialog = null;
            systemDialogConfigJson = null;
            unsubscribeFromUI();
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
