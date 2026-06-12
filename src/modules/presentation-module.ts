/**
 * PresentationModule - the UI presenter (Phases A+B of
 * planning/UI_STATE_ARCHITECTURE.md).
 *
 * Owns both UI wires of the target architecture:
 *
 * - api:ui:event (renderer → main): zod-validated intake. `log` events are
 *   load-bearing (replacement for the former api:log:* channels) and
 *   `panel-visibility` feeds the view-model; the remaining events are
 *   observational for now.
 * - api:ui:state (main → renderer): full UiState snapshots rebuilt from
 *   domain events and pushed coalesced per microtask. Phase B is a shadow:
 *   the renderer does not subscribe yet; each push is debug-logged so the
 *   stream can be analyzed offline (log.level=debug:presenter).
 *
 * The view-model mirrors today's renderer store semantics (projects store,
 * creating placeholders, deletion lifecycle, agent status, active workspace,
 * panel visibility, theme). Workspace keys are presenter-assigned and opaque
 * to the renderer. Pushing starts at the app:started event, which fires after
 * the initial project:open dispatches complete.
 */

import type { IntentModule, EventDeclarations } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { IpcBoundary, IpcEventHandler } from "../boundaries/shell/ipc";
import type { Logging, LoggerName, LogContext } from "../boundaries/platform/logging";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import type { PathProvider } from "../boundaries/platform/path-provider";
import type { IViewManager } from "../boundaries/shell/view-manager.interface";
import type { Theme } from "../boundaries/shell/window-manager";
import type { Unsubscribe } from "../shared/api/interfaces";
import type { AgentStatus, DeletionProgress } from "../shared/api/types";
import { extractTags } from "../shared/api/types";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import { EVENT_APP_STARTED } from "../intents/app-ready";
import { EVENT_PROJECT_OPENED, type ProjectOpenedEvent } from "../intents/open-project";
import { EVENT_PROJECT_CLOSED, type ProjectClosedEvent } from "../intents/close-project";
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
  type WorkspaceDeletedEvent,
  type WorkspaceDeletionProgressEvent,
} from "../intents/delete-workspace";
import { EVENT_WORKSPACE_SWITCHED, type WorkspaceSwitchedEvent } from "../intents/switch-workspace";
import {
  EVENT_AGENT_STATUS_UPDATED,
  type AgentStatusUpdatedEvent,
} from "../intents/update-agent-status";
import { EVENT_METADATA_CHANGED, type MetadataChangedEvent } from "../intents/set-metadata";
import { ApiIpcChannels } from "../shared/ipc";
import { uiEventSchema } from "../shared/ui-event";
import {
  compareDisplayNames,
  type UiMainView,
  type UiProjectRow,
  type UiState,
  type UiWorkspaceRow,
} from "../shared/ui-state";
import { buildScreenshotPath } from "./hibernation-screenshot-module";

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

interface WorkspaceModel {
  readonly name: string;
  /** Real worktree path; null while the workspace is still being created. */
  path: string | null;
  metadata: Record<string, string>;
  url: string | undefined;
  creating: boolean;
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
  let panelOpen = false;
  let theme: Theme = "dark";
  let started = false;
  let pushScheduled = false;
  let themeUnsubscribe: Unsubscribe | null = null;

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

  function isHibernated(workspace: WorkspaceModel): boolean {
    return workspace.metadata["hibernated"] === "true";
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

  function buildMain(): UiMainView {
    if (panelOpen) return { kind: "creation" };
    if (activeKey === null) return { kind: "empty" };
    const active = findByKey(activeKey);
    if (!active) return { kind: "empty" };
    if (isHibernated(active.workspace)) {
      return {
        kind: "hibernated",
        screenshot: resolveScreenshot(activeKey, active.project, active.workspace),
      };
    }
    return { kind: "workspace", frameKey: activeKey };
  }

  function buildSnapshot(): UiState {
    const projectRows: UiProjectRow[] = [...projects.values()]
      .sort((a, b) => compareDisplayNames(a.name, b.name))
      .map((project) => ({
        id: project.id,
        name: project.name,
        title: project.remoteUrl ?? project.path,
        workspaces: [...project.workspaces.values()]
          .sort((a, b) => compareDisplayNames(a.name, b.name))
          .map((workspace): UiWorkspaceRow => {
            const key = workspaceKey(project.id, workspace.name);
            return {
              key,
              name: workspace.name,
              status: rowStatus(workspace),
              hibernated: isHibernated(workspace),
              agent:
                (workspace.path === null ? undefined : agentStatuses.get(workspace.path)) ??
                AGENT_NONE,
              tags: extractTags(workspace.metadata),
              active: key === activeKey,
            };
          }),
      }));

    const frames: Record<string, string> = {};
    for (const project of projects.values()) {
      for (const workspace of project.workspaces.values()) {
        if (workspace.url !== undefined && !isHibernated(workspace)) {
          frames[workspaceKey(project.id, workspace.name)] = workspace.url;
        }
      }
    }

    return { sidebar: { projects: projectRows }, frames, main: buildMain(), theme };
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

  const listener: IpcEventHandler = (_event: unknown, ...args: unknown[]) => {
    const result = uiEventSchema.safeParse(args[0]);
    if (!result.success) {
      logger.warn("Dropped invalid ui event", {
        issue: result.error.issues[0]?.message ?? "unknown",
      });
      return;
    }
    const event = result.data;
    if (event.kind === "log") {
      try {
        const target = deps.loggingService.createLogger(toLoggerName(event.logger));
        target[event.level](event.message, event.context as LogContext | undefined);
      } catch {
        // Swallow errors - logging should never crash the app
      }
      return;
    }
    if (event.kind === "panel-visibility") {
      panelOpen = event.open;
      scheduleUpdate();
    }
    logger.debug("ui event", { kind: event.kind });
  };

  deps.ipcLayer.on(ApiIpcChannels.UI_EVENT, listener);

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
                metadata: { ...workspace.metadata },
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
            metadata: { ...p.metadata },
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
          metadata: {},
          url: undefined,
          creating: true,
        });
        // Landing in the creating placeholder is the visual confirmation the
        // workspace is being made; the creation panel closes.
        activeKey = workspaceKey(project.id, p.workspaceName);
        panelOpen = false;
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
        if (p.value === null) {
          delete workspace.metadata[p.key];
        } else {
          workspace.metadata[p.key] = p.value;
        }
        if (p.key === "hibernated") {
          // Flag flips invalidate the cached screenshot (deleted on wake).
          screenshots.delete(workspaceKey(p.projectId, p.workspaceName));
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
  };

  return {
    name: "presentation",
    events,
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async (): Promise<void> => {
            deps.ipcLayer.removeListener(ApiIpcChannels.UI_EVENT, listener);
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
