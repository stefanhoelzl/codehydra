/**
 * IpcEventBridge - Bridges domain events to the renderer via sendToUI,
 * and registers all IPC handlers directly on the IpcLayer.
 *
 * This is an IntentModule that:
 * 1. Subscribes to domain events and forwards them to sendToUI for IPC
 * 2. Registers IPC handlers (intent dispatch bridges) directly on ipcLayer
 * 3. On app:shutdown, removes all registered IPC handlers
 */

import type { IntentModule, EventDeclarations } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import type {
  ProjectOpenPayload,
  ProjectClosePayload,
  ProjectClonePayload,
  ProjectPathPayload,
  WorkspaceCreatePayload,
  WorkspaceRemovePayload,
  WorkspaceSetMetadataPayload,
  WorkspaceGetPayload,
  UiSwitchWorkspacePayload,
  UiSetModePayload,
  SetupErrorPayload,
  WorkspacePath,
} from "../../shared/ipc";
import { ApiIpcChannels } from "../../shared/ipc";
import type { Logger } from "../../services/logging";
import type { IpcLayer } from "../../services/platform/ipc";
import type { PluginServer } from "../../services/plugin-server";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import type { MetadataChangedPayload, MetadataChangedEvent } from "../operations/set-metadata";
import { EVENT_METADATA_CHANGED, INTENT_SET_METADATA } from "../operations/set-metadata";
import type { SetMetadataIntent } from "../operations/set-metadata";
import type { ModeChangedPayload, ModeChangedEvent } from "../operations/set-mode";
import { EVENT_MODE_CHANGED, INTENT_SET_MODE } from "../operations/set-mode";
import type { SetModeIntent } from "../operations/set-mode";
import type { WorkspaceCreatedEvent } from "../operations/open-workspace";
import { EVENT_WORKSPACE_CREATED, INTENT_OPEN_WORKSPACE } from "../operations/open-workspace";
import type { OpenWorkspaceIntent } from "../operations/open-workspace";
import type {
  WorkspaceDeletedEvent,
  WorkspaceDeletionProgressEvent,
} from "../operations/delete-workspace";
import {
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETION_PROGRESS,
  INTENT_DELETE_WORKSPACE,
} from "../operations/delete-workspace";
import type { DeleteWorkspaceIntent } from "../operations/delete-workspace";
import type {
  ProjectOpenedEvent,
  CloneProgressEvent,
  ProjectOpenFailedEvent,
} from "../operations/open-project";
import {
  EVENT_PROJECT_OPENED,
  EVENT_CLONE_PROGRESS,
  EVENT_PROJECT_OPEN_FAILED,
  INTENT_OPEN_PROJECT,
} from "../operations/open-project";
import type { OpenProjectIntent } from "../operations/open-project";
import type { ProjectClosedEvent } from "../operations/close-project";
import { EVENT_PROJECT_CLOSED, INTENT_CLOSE_PROJECT } from "../operations/close-project";
import type { CloseProjectIntent } from "../operations/close-project";
import type { WorkspaceSwitchedEvent } from "../operations/switch-workspace";
import { EVENT_WORKSPACE_SWITCHED, INTENT_SWITCH_WORKSPACE } from "../operations/switch-workspace";
import type { SwitchWorkspaceIntent } from "../operations/switch-workspace";
import type { AgentStatusUpdatedEvent } from "../operations/update-agent-status";
import { EVENT_AGENT_STATUS_UPDATED } from "../operations/update-agent-status";
import type { BasesUpdatedEvent } from "../operations/get-project-bases";
import { EVENT_BASES_UPDATED, INTENT_GET_PROJECT_BASES } from "../operations/get-project-bases";
import type { GetProjectBasesIntent } from "../operations/get-project-bases";
import { EVENT_SETUP_ERROR, EVENT_SETUP_PROGRESS } from "../operations/setup";
import type { SetupErrorEvent, SetupProgressEvent } from "../operations/setup";
import { EVENT_UPDATE_PROGRESS } from "../operations/update-apply";
import type { UpdateProgressEvent } from "../operations/update-apply";
import type { WorkspaceStatus, Workspace } from "../../shared/api/types";
import { INTENT_GET_METADATA } from "../operations/get-metadata";
import type { GetMetadataIntent } from "../operations/get-metadata";
import { INTENT_GET_WORKSPACE_STATUS } from "../operations/get-workspace-status";
import type { GetWorkspaceStatusIntent } from "../operations/get-workspace-status";
import { INTENT_GET_AGENT_SESSION } from "../operations/get-agent-session";
import type { GetAgentSessionIntent } from "../operations/get-agent-session";
import { INTENT_RESTART_AGENT } from "../operations/restart-agent";
import type { RestartAgentIntent } from "../operations/restart-agent";
import { INTENT_GET_ACTIVE_WORKSPACE } from "../operations/get-active-workspace";
import type { GetActiveWorkspaceIntent } from "../operations/get-active-workspace";
import { INTENT_APP_SHUTDOWN } from "../operations/app-shutdown";
import type { AppShutdownIntent } from "../operations/app-shutdown";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";
import { Path } from "../../services/platform/path";

/**
 * Dependencies for the IpcEventBridge module.
 */
export interface IpcEventBridgeDeps {
  readonly ipcLayer: IpcLayer;
  readonly sendToUI: (channel: string, ...args: unknown[]) => void;
  readonly pluginServer: PluginServer | null;
  readonly logger: Logger;
  readonly dispatcher: Dispatcher;
  readonly readyHandler: (payload: object) => Promise<void>;
  readonly agentStatusManager: {
    getStatus(wp: WorkspacePath): { status: string } | undefined;
  };
}

/**
 * Create an IpcEventBridge module that forwards domain events to the renderer
 * via sendToUI and registers all IPC handlers directly on the ipcLayer.
 *
 * @param deps - Module dependencies
 * @returns IntentModule with event subscriptions and lifecycle hooks
 */
export function createIpcEventBridge(deps: IpcEventBridgeDeps): IntentModule {
  const { dispatcher, logger } = deps;

  // Track registered IPC channels for cleanup
  const registeredChannels: string[] = [];

  /**
   * Register an IPC handler on the ipcLayer.
   * Converts undefined/null payloads to empty objects for handlers expecting EmptyPayload.
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
    [EVENT_METADATA_CHANGED]: (event: DomainEvent) => {
      const payload = (event as MetadataChangedEvent).payload as MetadataChangedPayload;
      deps.sendToUI(ApiIpcChannels.WORKSPACE_METADATA_CHANGED, {
        projectId: payload.projectId,
        workspaceName: payload.workspaceName,
        key: payload.key,
        value: payload.value,
      });
    },
    [EVENT_MODE_CHANGED]: (event: DomainEvent) => {
      const payload = (event as ModeChangedEvent).payload as ModeChangedPayload;
      deps.sendToUI(ApiIpcChannels.UI_MODE_CHANGED, {
        mode: payload.mode,
        previousMode: payload.previousMode,
      });
    },
    [EVENT_WORKSPACE_CREATED]: (event: DomainEvent) => {
      const p = (event as WorkspaceCreatedEvent).payload;
      deps.sendToUI(ApiIpcChannels.WORKSPACE_CREATED, {
        projectId: p.projectId,
        workspace: {
          projectId: p.projectId,
          name: p.workspaceName,
          branch: p.branch,
          metadata: p.metadata,
          path: p.workspacePath,
        },
        ...(p.initialPrompt && { hasInitialPrompt: true }),
        ...(p.stealFocus !== undefined && { stealFocus: p.stealFocus }),
      });
    },
    [EVENT_WORKSPACE_DELETED]: (event: DomainEvent) => {
      const payload = (event as WorkspaceDeletedEvent).payload;
      deps.sendToUI(ApiIpcChannels.WORKSPACE_REMOVED, {
        projectId: payload.projectId,
        workspaceName: payload.workspaceName,
        path: payload.workspacePath,
      });
    },
    [EVENT_WORKSPACE_DELETION_PROGRESS]: (event: DomainEvent) => {
      const progress = (event as WorkspaceDeletionProgressEvent).payload;
      deps.sendToUI(ApiIpcChannels.WORKSPACE_DELETION_PROGRESS, progress);
    },
    [EVENT_PROJECT_OPENED]: (event: DomainEvent) => {
      const p = (event as ProjectOpenedEvent).payload;
      deps.sendToUI(ApiIpcChannels.PROJECT_OPENED, { project: p.project });
    },
    [EVENT_PROJECT_CLOSED]: (event: DomainEvent) => {
      const p = (event as ProjectClosedEvent).payload;
      deps.sendToUI(ApiIpcChannels.PROJECT_CLOSED, { projectId: p.projectId });
    },
    [EVENT_WORKSPACE_SWITCHED]: (event: DomainEvent) => {
      const payload = (event as WorkspaceSwitchedEvent).payload;
      if (payload === null) {
        deps.sendToUI(ApiIpcChannels.WORKSPACE_SWITCHED, null);
      } else {
        deps.sendToUI(ApiIpcChannels.WORKSPACE_SWITCHED, {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
          path: payload.path,
        });
      }
    },
    [EVENT_SETUP_PROGRESS]: (event: DomainEvent) => {
      const payload = (event as SetupProgressEvent).payload;
      deps.sendToUI(ApiIpcChannels.LIFECYCLE_SETUP_PROGRESS, payload);
    },
    [EVENT_CLONE_PROGRESS]: (event: DomainEvent) => {
      const payload = (event as CloneProgressEvent).payload;
      deps.sendToUI(ApiIpcChannels.PROJECT_CLONE_PROGRESS, payload);
    },
    [EVENT_PROJECT_OPEN_FAILED]: (event: DomainEvent) => {
      const payload = (event as ProjectOpenFailedEvent).payload;
      deps.sendToUI(ApiIpcChannels.PROJECT_CLONE_FAILED, {
        reason: payload.reason,
        url: payload.git,
      });
    },
    [EVENT_SETUP_ERROR]: (event: DomainEvent) => {
      const { message, code } = (event as SetupErrorEvent).payload;
      const errorPayload: SetupErrorPayload = {
        message,
        ...(code !== undefined && { code }),
      };
      deps.sendToUI(ApiIpcChannels.LIFECYCLE_SETUP_ERROR, errorPayload);
    },
    [EVENT_UPDATE_PROGRESS]: (event: DomainEvent) => {
      const payload = (event as UpdateProgressEvent).payload;
      deps.sendToUI(ApiIpcChannels.UPDATE_PROGRESS, payload);
    },
    [EVENT_BASES_UPDATED]: (event: DomainEvent) => {
      const p = (event as BasesUpdatedEvent).payload;
      deps.sendToUI(ApiIpcChannels.PROJECT_BASES_UPDATED, {
        projectId: p.projectId,
        projectPath: p.projectPath,
        bases: p.bases,
      });
    },
    [EVENT_AGENT_STATUS_UPDATED]: (event: DomainEvent) => {
      const {
        workspacePath,
        projectId,
        workspaceName,
        status: aggregatedStatus,
      } = (event as AgentStatusUpdatedEvent).payload;

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

      deps.sendToUI(ApiIpcChannels.WORKSPACE_STATUS_CHANGED, {
        projectId,
        workspaceName,
        path: workspacePath,
        status,
      });
    },
  };

  // ---------------------------------------------------------------------------
  // Register IPC handlers directly on ipcLayer
  // ---------------------------------------------------------------------------

  registerIpc(ApiIpcChannels.LIFECYCLE_READY, async (payload) => {
    await deps.readyHandler(payload as object);
  });

  registerIpc(ApiIpcChannels.LIFECYCLE_QUIT, async () => {
    logger.debug("Quit requested");
    await dispatcher.dispatch({
      type: INTENT_APP_SHUTDOWN,
      payload: {},
    } as AppShutdownIntent);
  });

  registerIpc(ApiIpcChannels.WORKSPACE_CREATE, async (payload) => {
    const p = payload as WorkspaceCreatePayload;
    if (!p.projectPath) {
      throw new Error("projectPath is required");
    }
    const intent: OpenWorkspaceIntent = {
      type: INTENT_OPEN_WORKSPACE,
      payload: {
        projectPath: p.projectPath,
        workspaceName: p.name,
        base: p.base,
        ...(p.initialPrompt !== undefined && { initialPrompt: p.initialPrompt }),
        ...(p.stealFocus !== undefined && { stealFocus: p.stealFocus }),
      },
    };
    const result = await dispatcher.dispatch(intent);
    if (!result) {
      throw new Error("Create workspace dispatch returned no result");
    }
    return result as Workspace;
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

  registerIpc(ApiIpcChannels.WORKSPACE_SET_METADATA, async (payload) => {
    const p = payload as WorkspaceSetMetadataPayload;
    const intent: SetMetadataIntent = {
      type: INTENT_SET_METADATA,
      payload: {
        workspacePath: p.workspacePath,
        key: p.key,
        value: p.value,
      },
    };
    await dispatcher.dispatch(intent);
  });

  registerIpc(ApiIpcChannels.WORKSPACE_GET_METADATA, async (payload) => {
    const p = payload as WorkspaceGetPayload;
    const intent: GetMetadataIntent = {
      type: INTENT_GET_METADATA,
      payload: { workspacePath: p.workspacePath },
    };
    const result = await dispatcher.dispatch(intent);
    if (!result) {
      throw new Error("Get metadata dispatch returned no result");
    }
    return result;
  });

  registerIpc(ApiIpcChannels.WORKSPACE_GET_STATUS, async (payload) => {
    const p = payload as WorkspaceGetPayload;
    const intent: GetWorkspaceStatusIntent = {
      type: INTENT_GET_WORKSPACE_STATUS,
      payload: { workspacePath: p.workspacePath },
    };
    const result = await dispatcher.dispatch(intent);
    if (!result) {
      throw new Error("Get workspace status dispatch returned no result");
    }
    return result;
  });

  registerIpc(ApiIpcChannels.WORKSPACE_GET_AGENT_SESSION, async (payload) => {
    const p = payload as WorkspaceGetPayload;
    const intent: GetAgentSessionIntent = {
      type: INTENT_GET_AGENT_SESSION,
      payload: { workspacePath: p.workspacePath },
    };
    return dispatcher.dispatch(intent);
  });

  registerIpc(ApiIpcChannels.WORKSPACE_RESTART_AGENT_SERVER, async (payload) => {
    const p = payload as WorkspaceGetPayload;
    const intent: RestartAgentIntent = {
      type: INTENT_RESTART_AGENT,
      payload: { workspacePath: p.workspacePath },
    };
    const result = await dispatcher.dispatch(intent);
    if (result === undefined) {
      throw new Error("Restart agent dispatch returned no result");
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

  registerIpc(ApiIpcChannels.UI_GET_ACTIVE_WORKSPACE, async () => {
    const intent: GetActiveWorkspaceIntent = {
      type: INTENT_GET_ACTIVE_WORKSPACE,
      payload: {} as Record<string, never>,
    };
    return dispatcher.dispatch(intent);
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

  registerIpc(ApiIpcChannels.PROJECT_CLONE, async (payload) => {
    const p = payload as ProjectClonePayload;
    const intent: OpenProjectIntent = {
      type: INTENT_OPEN_PROJECT,
      payload: { git: p.url },
    };
    const handle = dispatcher.dispatch(intent);
    if (!(await handle.accepted)) {
      throw new Error("Clone already in progress");
    }
    const result = await handle;
    if (!result) {
      throw new Error("Clone project dispatch returned no result");
    }
    return result;
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

  registerIpc(ApiIpcChannels.PROJECT_FETCH_BASES, async (payload) => {
    const p = payload as ProjectPathPayload;
    const intent: GetProjectBasesIntent = {
      type: INTENT_GET_PROJECT_BASES,
      payload: { projectPath: p.projectPath, refresh: true },
    };
    const result = await dispatcher.dispatch(intent);
    if (!result) {
      throw new Error("Fetch bases dispatch returned no result");
    }
    return { bases: result.bases };
  });

  return {
    name: "ipc-event-bridge",
    events,
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
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
