/**
 * UiIpcModule - Handles all bidirectional IPC between main process and renderer.
 *
 * This is an IntentModule that:
 * 1. Subscribes to domain events and forwards them to sendToUI for IPC
 * 2. Routes dialog/notification user events (renderer → main) to their managers
 * 3. On app:shutdown, removes the registered event listeners
 */

import type { IntentModule, EventDeclarations } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
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
} from "../intents/delete-workspace";
import type { ProjectOpenedEvent } from "../intents/open-project";
import { EVENT_PROJECT_OPENED } from "../intents/open-project";
import type { ProjectClosedEvent } from "../intents/close-project";
import { EVENT_PROJECT_CLOSED } from "../intents/close-project";
import type { WorkspaceSwitchedEvent } from "../intents/switch-workspace";
import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import type { AgentStatusUpdatedEvent } from "../intents/update-agent-status";
import { EVENT_AGENT_STATUS_UPDATED } from "../intents/update-agent-status";
import type { BasesUpdatedEvent } from "../intents/get-project-bases";
import { EVENT_BASES_UPDATED } from "../intents/get-project-bases";
import type { WorkspaceStatus } from "../shared/api/types";
import type { Dispatcher } from "../intents/lib/dispatcher";
import {
  EVENT_WORKSPACE_HIBERNATED,
  EVENT_WORKSPACE_HIBERNATE_FAILED,
  type WorkspaceHibernatedEvent,
  type WorkspaceHibernateFailedEvent,
} from "../intents/hibernate-workspace";
import {
  EVENT_WORKSPACE_WOKEN,
  EVENT_WORKSPACE_WAKE_FAILED,
  type WorkspaceWokenEvent,
  type WorkspaceWakeFailedEvent,
} from "../intents/wake-workspace";

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
}

/**
 * Create a UiIpc module that handles all bidirectional IPC between main
 * process and renderer: domain event forwarding and request-response handlers.
 *
 * @param deps - Module dependencies
 * @returns IntentModule with event subscriptions and lifecycle hooks
 */
export function createUiIpcModule(deps: UiIpcModuleDeps): IntentModule {
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

  // Startup readiness + markUIReady moved to the presenter's `ui-connected`
  // ui:event handler (the renderer emits it instead of invoking ready()).
  // App quit is driven entirely main-side (OS menu / window close) and, from
  // the renderer, via the `setup-quit` ui:event — there is no quit invoke.

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
          },
        },
      },
    },
  };
}
