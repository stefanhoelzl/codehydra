/**
 * UiIpcModule - Handles all bidirectional IPC between main process and renderer.
 *
 * This is an IntentModule that:
 * 1. Subscribes to domain events and forwards them to sendToUI for IPC
 * 2. Registers IPC handlers (intent dispatch bridges) directly on ipcLayer
 * 3. On app:shutdown, removes all registered handlers and listeners
 */

import type { IntentModule, EventDeclarations } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type {
  ProjectOpenPayload,
  ProjectClosePayload,
  WorkspaceRemovePayload,
  WorkspaceGetStatusPayload,
  UiSwitchWorkspacePayload,
  UiSetModePayload,
} from "../shared/ipc";
import { ApiIpcChannels } from "../shared/ipc";
import { agentSpecHasPrompt } from "../shared/api/types";
import type { DialogUserEvent } from "../shared/dialog-types";
import type { NotificationUserEvent } from "../shared/notification-types";
import type { DialogManager } from "./dialog-manager";
import type { NotificationManager } from "./notification-manager";
import type { Logger } from "../boundaries/platform/logging";
import type { IpcBoundary, IpcEventHandler } from "../boundaries/shell/ipc";
import type { IViewManager } from "../boundaries/shell/view-manager.interface";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import type { MetadataChangedPayload, MetadataChangedEvent } from "../intents/set-metadata";
import { EVENT_METADATA_CHANGED } from "../intents/set-metadata";
import type { ModeChangedPayload, ModeChangedEvent } from "../intents/set-mode";
import { EVENT_MODE_CHANGED, INTENT_SET_MODE } from "../intents/set-mode";
import type { SetModeIntent } from "../intents/set-mode";
import type {
  WorkspaceCreatedEvent,
  WorkspaceCreateFailedEvent,
  WorkspaceLoadingEvent,
} from "../intents/open-workspace";
import {
  EVENT_WORKSPACE_CREATED,
  EVENT_WORKSPACE_CREATE_FAILED,
  EVENT_WORKSPACE_LOADING,
} from "../intents/open-workspace";
import type {
  WorkspaceDeletedEvent,
  WorkspaceDeletionProgressEvent,
} from "../intents/delete-workspace";
import {
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETION_PROGRESS,
  INTENT_DELETE_WORKSPACE,
} from "../intents/delete-workspace";
import type { DeleteWorkspaceIntent } from "../intents/delete-workspace";
import type { ProjectOpenedEvent } from "../intents/open-project";
import { EVENT_PROJECT_OPENED, INTENT_OPEN_PROJECT } from "../intents/open-project";
import type { OpenProjectIntent } from "../intents/open-project";
import type { ProjectClosedEvent } from "../intents/close-project";
import { EVENT_PROJECT_CLOSED, INTENT_CLOSE_PROJECT } from "../intents/close-project";
import type { CloseProjectIntent } from "../intents/close-project";
import type { WorkspaceSwitchedEvent } from "../intents/switch-workspace";
import { EVENT_WORKSPACE_SWITCHED, INTENT_SWITCH_WORKSPACE } from "../intents/switch-workspace";
import type { SwitchWorkspaceIntent } from "../intents/switch-workspace";
import type { AgentStatusUpdatedEvent } from "../intents/update-agent-status";
import { EVENT_AGENT_STATUS_UPDATED } from "../intents/update-agent-status";
import type { BasesUpdatedEvent } from "../intents/get-project-bases";
import { EVENT_BASES_UPDATED } from "../intents/get-project-bases";
import type { ShortcutKeyPressedEvent } from "../intents/shortcut-key";
import { EVENT_SHORTCUT_KEY_PRESSED } from "../intents/shortcut-key";
import { isShortcutKey } from "../shared/shortcuts";
import type { WorkspaceStatus, Workspace } from "../shared/api/types";
import { INTENT_GET_WORKSPACE_STATUS } from "../intents/get-workspace-status";
import type { GetWorkspaceStatusIntent } from "../intents/get-workspace-status";
import { INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import type { AppShutdownIntent } from "../intents/app-shutdown";
import { INTENT_APP_READY } from "../intents/app-ready";
import type { AppReadyIntent } from "../intents/app-ready";
import type { Dispatcher } from "../intents/lib/dispatcher";
import { Path } from "../utils/path/path";
import {
  EVENT_WORKSPACE_HIBERNATED,
  EVENT_WORKSPACE_HIBERNATE_FAILED,
  INTENT_HIBERNATE_WORKSPACE,
  type HibernateWorkspaceIntent,
  type WorkspaceHibernatedEvent,
  type WorkspaceHibernateFailedEvent,
} from "../intents/hibernate-workspace";
import {
  EVENT_WORKSPACE_WOKEN,
  EVENT_WORKSPACE_WAKE_FAILED,
  INTENT_WAKE_WORKSPACE,
  type WakeWorkspaceIntent,
  type WorkspaceWokenEvent,
  type WorkspaceWakeFailedEvent,
} from "../intents/wake-workspace";
import { buildScreenshotPath } from "./hibernation-screenshot-module";
import type { PathProvider } from "../boundaries/platform/path-provider";

/**
 * Dependencies for the UiIpc module.
 */
export interface UiIpcModuleDeps {
  readonly ipcLayer: IpcBoundary;
  readonly viewManager: Pick<IViewManager, "sendToUI">;
  readonly logger: Logger;
  readonly dispatcher: Dispatcher;
  readonly dialogManager?: DialogManager;
  readonly notificationManager?: NotificationManager;
  /** Path provider used to resolve hibernation screenshot URLs. */
  readonly pathProvider: PathProvider;
}

/**
 * Create a UiIpc module that handles all bidirectional IPC between main
 * process and renderer: domain event forwarding and request-response handlers.
 *
 * @param deps - Module dependencies
 * @returns IntentModule with event subscriptions and lifecycle hooks
 */
export function createUiIpcModule(deps: UiIpcModuleDeps): IntentModule {
  const { dispatcher, logger } = deps;

  // Track registered IPC channels for cleanup
  const registeredChannels: string[] = [];

  /**
   * Register an IPC handler on the ipcLayer.
   * Converts undefined/null payloads to empty objects for handlers with no input.
   */
  function registerIpc(channel: string, handler: (payload: unknown) => Promise<unknown>): void {
    deps.ipcLayer.handle(channel, async (_event: unknown, payload: unknown) => {
      return handler(payload ?? {});
    });
    registeredChannels.push(channel);
  }

  // ---------------------------------------------------------------------------
  // Domain event → sendToUI subscriptions
  // ---------------------------------------------------------------------------

  const events: EventDeclarations = {
    [EVENT_METADATA_CHANGED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const payload = (event as MetadataChangedEvent).payload as MetadataChangedPayload;
        deps.viewManager.sendToUI(ApiIpcChannels.WORKSPACE_METADATA_CHANGED, {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
          key: payload.key,
          value: payload.value,
        });
      },
    },
    [EVENT_MODE_CHANGED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const payload = (event as ModeChangedEvent).payload as ModeChangedPayload;
        deps.viewManager.sendToUI(ApiIpcChannels.UI_MODE_CHANGED, {
          mode: payload.mode,
          previousMode: payload.previousMode,
        });
      },
    },
    [EVENT_WORKSPACE_CREATED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const p = (event as WorkspaceCreatedEvent).payload;
        deps.viewManager.sendToUI(ApiIpcChannels.WORKSPACE_CREATED, {
          projectId: p.projectId,
          workspace: {
            projectId: p.projectId,
            name: p.workspaceName,
            branch: p.branch,
            metadata: p.metadata,
            path: p.workspacePath,
            url: p.workspaceUrl,
          },
          ...(agentSpecHasPrompt(p.agent) && { hasInitialPrompt: true }),
          ...(p.stealFocus !== undefined && { stealFocus: p.stealFocus }),
        });
      },
    },
    [EVENT_WORKSPACE_LOADING]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const p = (event as WorkspaceLoadingEvent).payload;
        deps.viewManager.sendToUI(ApiIpcChannels.WORKSPACE_LOADING, {
          workspaceName: p.workspaceName,
          projectPath: p.projectPath,
          ...(p.base !== undefined && { base: p.base }),
        });
      },
    },
    [EVENT_WORKSPACE_CREATE_FAILED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const p = (event as WorkspaceCreateFailedEvent).payload;
        deps.viewManager.sendToUI(ApiIpcChannels.WORKSPACE_CREATE_FAILED, {
          workspaceName: p.workspaceName,
          projectPath: p.projectPath,
          error: p.error,
        });
      },
    },
    [EVENT_WORKSPACE_DELETED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const payload = (event as WorkspaceDeletedEvent).payload;
        deps.viewManager.sendToUI(ApiIpcChannels.WORKSPACE_REMOVED, {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
          path: payload.workspacePath,
        });
      },
    },
    [EVENT_WORKSPACE_DELETION_PROGRESS]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const progress = (event as WorkspaceDeletionProgressEvent).payload;
        deps.viewManager.sendToUI(ApiIpcChannels.WORKSPACE_DELETION_PROGRESS, progress);
      },
    },
    [EVENT_PROJECT_OPENED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const p = (event as ProjectOpenedEvent).payload;
        deps.viewManager.sendToUI(ApiIpcChannels.PROJECT_OPENED, { project: p.project });
      },
    },
    [EVENT_PROJECT_CLOSED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const p = (event as ProjectClosedEvent).payload;
        deps.viewManager.sendToUI(ApiIpcChannels.PROJECT_CLOSED, { projectId: p.projectId });
      },
    },
    [EVENT_WORKSPACE_SWITCHED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const payload = (event as WorkspaceSwitchedEvent).payload;
        if (payload === null) {
          deps.viewManager.sendToUI(ApiIpcChannels.WORKSPACE_SWITCHED, null);
        } else {
          deps.viewManager.sendToUI(ApiIpcChannels.WORKSPACE_SWITCHED, {
            projectId: payload.projectId,
            workspaceName: payload.workspaceName,
            path: payload.path,
          });
        }
      },
    },
    // NOTE: EVENT_SETUP_PROGRESS forwarding removed — handled by view-module
    // NOTE: EVENT_CLONE_PROGRESS forwarding removed — handled by clone-notification-module
    // NOTE: EVENT_PROJECT_OPEN_FAILED forwarding removed — handled by clone-notification-module
    // NOTE: EVENT_SETUP_ERROR forwarding removed — handled by view-module
    // NOTE: EVENT_UPDATE_PROGRESS forwarding removed — handled by auto-updater-module
    [EVENT_BASES_UPDATED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const p = (event as BasesUpdatedEvent).payload;
        deps.viewManager.sendToUI(ApiIpcChannels.PROJECT_BASES_UPDATED, {
          projectId: p.projectId,
          projectPath: p.projectPath,
          bases: p.bases,
          ...(p.defaultBaseBranch !== undefined && { defaultBaseBranch: p.defaultBaseBranch }),
        });
      },
    },
    [EVENT_SHORTCUT_KEY_PRESSED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const { key } = (event as ShortcutKeyPressedEvent).payload;
        if (isShortcutKey(key)) {
          deps.viewManager.sendToUI(ApiIpcChannels.SHORTCUT_KEY, key);
        }
      },
    },
    [EVENT_WORKSPACE_HIBERNATED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const payload = (event as WorkspaceHibernatedEvent).payload;
        deps.viewManager.sendToUI(ApiIpcChannels.WORKSPACE_HIBERNATED, {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
          path: payload.workspacePath,
        });
      },
    },
    [EVENT_WORKSPACE_HIBERNATE_FAILED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const payload = (event as WorkspaceHibernateFailedEvent).payload;
        deps.viewManager.sendToUI(ApiIpcChannels.WORKSPACE_HIBERNATE_FAILED, {
          path: payload.workspacePath,
          error: payload.error,
        });
      },
    },
    [EVENT_WORKSPACE_WOKEN]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const payload = (event as WorkspaceWokenEvent).payload;
        deps.viewManager.sendToUI(ApiIpcChannels.WORKSPACE_WOKEN, {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
          path: payload.workspacePath,
        });
      },
    },
    [EVENT_WORKSPACE_WAKE_FAILED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const payload = (event as WorkspaceWakeFailedEvent).payload;
        deps.viewManager.sendToUI(ApiIpcChannels.WORKSPACE_WAKE_FAILED, {
          path: payload.workspacePath,
          error: payload.error,
        });
      },
    },
    [EVENT_AGENT_STATUS_UPDATED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const { workspace, status: aggregatedStatus } = (event as AgentStatusUpdatedEvent).payload;
        const { path: workspacePath, projectId, name: workspaceName } = workspace;

        const status: WorkspaceStatus =
          aggregatedStatus.status === "none"
            ? { isDirty: false, unmergedCommits: 0, agent: { type: "none" } }
            : {
                isDirty: false,
                unmergedCommits: 0,
                agent: {
                  type: aggregatedStatus.status,
                  counts: {
                    idle: aggregatedStatus.counts.idle,
                    busy: aggregatedStatus.counts.busy,
                    total: aggregatedStatus.counts.idle + aggregatedStatus.counts.busy,
                  },
                },
              };

        deps.viewManager.sendToUI(ApiIpcChannels.WORKSPACE_STATUS_CHANGED, {
          projectId,
          workspaceName,
          path: workspacePath,
          status,
        });
      },
    },
  };

  // ---------------------------------------------------------------------------
  // Register IPC handlers directly on ipcLayer
  // ---------------------------------------------------------------------------

  registerIpc(ApiIpcChannels.LIFECYCLE_READY, async () => {
    // The renderer calls lifecycle.ready() once MainView (and its
    // NotificationHost) is mounted — buffered notifications can now render.
    deps.notificationManager?.markUIReady();
    return await dispatcher.dispatch({
      type: INTENT_APP_READY,
      payload: {},
    } as AppReadyIntent);
  });

  registerIpc(ApiIpcChannels.LIFECYCLE_QUIT, async () => {
    logger.debug("Quit requested");
    await dispatcher.dispatch({
      type: INTENT_APP_SHUTDOWN,
      payload: {},
    } as AppShutdownIntent);
  });

  registerIpc(ApiIpcChannels.WORKSPACE_REMOVE, async (payload) => {
    const p = payload as WorkspaceRemovePayload;
    const intent: DeleteWorkspaceIntent = {
      type: INTENT_DELETE_WORKSPACE,
      payload: {
        workspacePath: p.workspacePath,
        keepBranch: p.keepBranch ?? true,
        force: p.force ?? false,
        removeWorktree: true,
        ignoreWarnings: p.ignoreWarnings ?? false,
        ...(p.skipSwitch !== undefined && { skipSwitch: p.skipSwitch }),
        ...(p.blockingPids !== undefined && { blockingPids: p.blockingPids }),
      },
    };

    const handle = dispatcher.dispatch(intent);
    if (!(await handle.accepted)) {
      return { started: false };
    }
    void handle.catch(() => {}); // Errors communicated via domain events
    return { started: true };
  });

  registerIpc(ApiIpcChannels.WORKSPACE_HIBERNATE, async (payload) => {
    const p = payload as { workspacePath: string };
    const intent: HibernateWorkspaceIntent = {
      type: INTENT_HIBERNATE_WORKSPACE,
      payload: {
        workspacePath: p.workspacePath,
      },
    };
    const handle = dispatcher.dispatch(intent);
    if (!(await handle.accepted)) {
      return { started: false };
    }
    void handle.catch(() => {}); // Errors communicated via domain events
    return { started: true };
  });

  registerIpc(ApiIpcChannels.WORKSPACE_WAKE, async (payload) => {
    const p = payload as { workspacePath: string };
    // wake now clears the hibernated flag AND reopens the workspace (restarts
    // the agent server, rebuilds the view) by dispatching workspace:open
    // internally. source "ui-ipc" makes open's failures surface as UI
    // notifications; stealFocus is omitted so the woken workspace is focused.
    const intent: WakeWorkspaceIntent = {
      type: INTENT_WAKE_WORKSPACE,
      payload: { workspacePath: p.workspacePath, source: "ui-ipc" },
    };
    // result is undefined only when a concurrent wake for the same workspace
    // was deduped by the idempotency interceptor.
    const result = await dispatcher.dispatch(intent);
    return (result ?? null) as Workspace | null;
  });

  registerIpc(ApiIpcChannels.WORKSPACE_GET_SCREENSHOT, async (payload) => {
    const p = payload as { projectId: string; workspaceName: string };
    const filePath = buildScreenshotPath(deps.pathProvider, p.projectId, p.workspaceName);
    return { url: `file://${filePath.toNative()}` };
  });

  registerIpc(ApiIpcChannels.WORKSPACE_GET_STATUS, async (payload) => {
    const p = payload as WorkspaceGetStatusPayload;
    const intent: GetWorkspaceStatusIntent = {
      type: INTENT_GET_WORKSPACE_STATUS,
      payload: {
        workspacePath: p.workspacePath,
        ...(p.refresh !== undefined && { refresh: p.refresh }),
      },
    };
    const result = await dispatcher.dispatch(intent);
    if (!result) {
      throw new Error("Get workspace status dispatch returned no result");
    }
    return result;
  });

  registerIpc(ApiIpcChannels.UI_SET_MODE, async (payload) => {
    const p = payload as UiSetModePayload;
    const intent: SetModeIntent = {
      type: INTENT_SET_MODE,
      payload: { mode: p.mode },
    };
    await dispatcher.dispatch(intent);
  });

  registerIpc(ApiIpcChannels.UI_SWITCH_WORKSPACE, async (payload) => {
    const p = payload as UiSwitchWorkspacePayload;
    const intent: SwitchWorkspaceIntent = {
      type: INTENT_SWITCH_WORKSPACE,
      payload: {
        workspacePath: p.workspacePath,
        ...(p.focus !== undefined && { focus: p.focus }),
      },
    };
    await dispatcher.dispatch(intent);
  });

  registerIpc(ApiIpcChannels.PROJECT_OPEN, async (payload) => {
    const p = payload as ProjectOpenPayload;
    const intent: OpenProjectIntent = {
      type: INTENT_OPEN_PROJECT,
      payload: {
        ...(p.path !== undefined && { path: new Path(p.path) }),
      },
    };
    const handle = dispatcher.dispatch(intent);
    if (!(await handle.accepted)) {
      throw new Error("Project open already in progress");
    }
    return await handle;
  });

  registerIpc(ApiIpcChannels.PROJECT_CLOSE, async (payload) => {
    const p = payload as ProjectClosePayload;
    const intent: CloseProjectIntent = {
      type: INTENT_CLOSE_PROJECT,
      payload: {
        projectPath: p.projectPath,
        ...(p.removeLocalRepo !== undefined && { removeLocalRepo: p.removeLocalRepo }),
      },
    };
    await dispatcher.dispatch(intent);
  });

  // ---------------------------------------------------------------------------
  // Dialog event routing (renderer → main)
  // ---------------------------------------------------------------------------

  let dialogEventCleanup: (() => void) | null = null;
  if (deps.dialogManager) {
    const dialogManager = deps.dialogManager;
    const handler = (_event: unknown, ...args: unknown[]) => {
      const event = args[0] as DialogUserEvent;
      dialogManager.routeEvent(event);
    };
    deps.ipcLayer.on(ApiIpcChannels.DIALOG_EVENT, handler);
    dialogEventCleanup = () => {
      deps.ipcLayer.removeListener(ApiIpcChannels.DIALOG_EVENT, handler);
    };
  }

  // ---------------------------------------------------------------------------
  // Notification event routing (renderer → main)
  // ---------------------------------------------------------------------------

  let notificationEventCleanup: (() => void) | null = null;
  if (deps.notificationManager) {
    const notificationManager = deps.notificationManager;
    const handler: IpcEventHandler = (_event: unknown, ...args: unknown[]) => {
      const event = args[0] as NotificationUserEvent;
      notificationManager.routeEvent(event);
    };
    deps.ipcLayer.on(ApiIpcChannels.NOTIFICATION_EVENT, handler);
    notificationEventCleanup = () => {
      deps.ipcLayer.removeListener(ApiIpcChannels.NOTIFICATION_EVENT, handler);
    };
  }

  return {
    name: "ui-ipc",
    events,
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            if (dialogEventCleanup) {
              dialogEventCleanup();
              dialogEventCleanup = null;
            }
            if (notificationEventCleanup) {
              notificationEventCleanup();
              notificationEventCleanup = null;
            }
            for (const channel of registeredChannels) {
              try {
                deps.ipcLayer.removeHandler(channel);
              } catch {
                // Continue cleanup even if a handler was already removed
              }
            }
          },
        },
      },
    },
  };
}
