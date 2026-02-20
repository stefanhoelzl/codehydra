/**
 * IpcEventBridge - Bridges domain events to the ApiRegistry event system
 * and manages IPC lifecycle (API event wiring, plugin API).
 *
 * This is an IntentModule that:
 * 1. Subscribes to domain events and forwards them to ApiRegistry.emit() for IPC
 * 2. On app:start, wires API events to IPC and sets up the Plugin API
 * 3. On app:shutdown, cleans up event subscriptions
 * 4. Manages plugin workspace registration on workspace created/deleted events
 */

import type { WebContents } from "electron";
import type { IntentModule, EventDeclarations } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { IApiRegistry } from "../api/registry-types";
import type { ICodeHydraApi, Unsubscribe } from "../../shared/api/interfaces";
import type { Logger } from "../../services/logging";
import type { PluginServer } from "../../services/plugin-server";
import type { StartHookResult } from "../operations/app-start";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { wireApiEvents } from "../ipc/api-handlers";
import { wirePluginApi } from "../api/wire-plugin-api";
import type { MetadataChangedPayload, MetadataChangedEvent } from "../operations/set-metadata";
import { EVENT_METADATA_CHANGED } from "../operations/set-metadata";
import type { ModeChangedPayload, ModeChangedEvent } from "../operations/set-mode";
import { EVENT_MODE_CHANGED } from "../operations/set-mode";
import type { WorkspaceCreatedEvent } from "../operations/open-workspace";
import { EVENT_WORKSPACE_CREATED } from "../operations/open-workspace";
import type { WorkspaceDeletedEvent } from "../operations/delete-workspace";
import { EVENT_WORKSPACE_DELETED } from "../operations/delete-workspace";
import type { ProjectOpenedEvent } from "../operations/open-project";
import { EVENT_PROJECT_OPENED } from "../operations/open-project";
import type { ProjectClosedEvent } from "../operations/close-project";
import { EVENT_PROJECT_CLOSED } from "../operations/close-project";
import type { WorkspaceSwitchedEvent } from "../operations/switch-workspace";
import { EVENT_WORKSPACE_SWITCHED } from "../operations/switch-workspace";
import type { AgentStatusUpdatedEvent } from "../operations/update-agent-status";
import { EVENT_AGENT_STATUS_UPDATED } from "../operations/update-agent-status";
import { EVENT_SETUP_ERROR, EVENT_SETUP_PROGRESS } from "../operations/setup";
import type { SetupErrorEvent, SetupProgressEvent } from "../operations/setup";
import type { SetupErrorPayload } from "../../shared/ipc";
import { ApiIpcChannels } from "../../shared/ipc";
import type { WorkspaceStatus } from "../../shared/api/types";

/**
 * Dependencies for the IpcEventBridge module.
 */
export interface IpcEventBridgeDeps {
  readonly apiRegistry: IApiRegistry;
  readonly getApi: () => ICodeHydraApi;
  readonly getUIWebContents: () => WebContents | null;
  readonly pluginServer: PluginServer | null;
  readonly logger: Logger;
}

/**
 * Create an IpcEventBridge module that forwards domain events to the API registry
 * and manages IPC lifecycle (API event wiring, plugin API).
 *
 * @param deps - Module dependencies
 * @returns IntentModule with event subscriptions and lifecycle hooks
 */
export function createIpcEventBridge(deps: IpcEventBridgeDeps): IntentModule {
  const { apiRegistry } = deps;

  // Closure state for lifecycle management
  let apiEventCleanupFn: Unsubscribe | null = null;

  const events: EventDeclarations = {
    [EVENT_METADATA_CHANGED]: (event: DomainEvent) => {
      const payload = (event as MetadataChangedEvent).payload as MetadataChangedPayload;
      apiRegistry.emit("workspace:metadata-changed", {
        projectId: payload.projectId,
        workspaceName: payload.workspaceName,
        key: payload.key,
        value: payload.value,
      });
    },
    [EVENT_MODE_CHANGED]: (event: DomainEvent) => {
      const payload = (event as ModeChangedEvent).payload as ModeChangedPayload;
      apiRegistry.emit("ui:mode-changed", {
        mode: payload.mode,
        previousMode: payload.previousMode,
      });
    },
    [EVENT_WORKSPACE_CREATED]: (event: DomainEvent) => {
      const p = (event as WorkspaceCreatedEvent).payload;
      apiRegistry.emit("workspace:created", {
        projectId: p.projectId,
        workspace: {
          projectId: p.projectId,
          name: p.workspaceName,
          branch: p.branch,
          metadata: p.metadata,
          path: p.workspacePath,
        },
        ...(p.initialPrompt && { hasInitialPrompt: true }),
        ...(p.keepInBackground && { keepInBackground: true }),
      });
    },
    [EVENT_WORKSPACE_DELETED]: (event: DomainEvent) => {
      const payload = (event as WorkspaceDeletedEvent).payload;
      apiRegistry.emit("workspace:removed", {
        projectId: payload.projectId,
        workspaceName: payload.workspaceName,
        path: payload.workspacePath,
      });
    },
    [EVENT_PROJECT_OPENED]: (event: DomainEvent) => {
      const p = (event as ProjectOpenedEvent).payload;
      apiRegistry.emit("project:opened", { project: p.project });
    },
    [EVENT_PROJECT_CLOSED]: (event: DomainEvent) => {
      const p = (event as ProjectClosedEvent).payload;
      apiRegistry.emit("project:closed", { projectId: p.projectId });
    },
    [EVENT_WORKSPACE_SWITCHED]: (event: DomainEvent) => {
      const payload = (event as WorkspaceSwitchedEvent).payload;
      if (payload === null) {
        apiRegistry.emit("workspace:switched", null);
      } else {
        apiRegistry.emit("workspace:switched", {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
          path: payload.path,
        });
      }
    },
    [EVENT_SETUP_PROGRESS]: (event: DomainEvent) => {
      const payload = (event as SetupProgressEvent).payload;
      const webContents = deps.getUIWebContents();
      if (webContents && !webContents.isDestroyed()) {
        webContents.send(ApiIpcChannels.LIFECYCLE_SETUP_PROGRESS, payload);
      }
    },
    [EVENT_SETUP_ERROR]: (event: DomainEvent) => {
      const { message, code } = (event as SetupErrorEvent).payload;
      const payload: SetupErrorPayload = {
        message,
        ...(code !== undefined && { code }),
      };
      const webContents = deps.getUIWebContents();
      if (webContents && !webContents.isDestroyed()) {
        webContents.send(ApiIpcChannels.LIFECYCLE_SETUP_ERROR, payload);
      }
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
          ? { isDirty: false, agent: { type: "none" } }
          : {
              isDirty: false,
              agent: {
                type: aggregatedStatus.status,
                counts: {
                  idle: aggregatedStatus.counts.idle,
                  busy: aggregatedStatus.counts.busy,
                  total: aggregatedStatus.counts.idle + aggregatedStatus.counts.busy,
                },
              },
            };

      apiRegistry.emit("workspace:status-changed", {
        projectId,
        workspaceName,
        path: workspacePath,
        status,
      });
    },
  };

  return {
    events,
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<StartHookResult> => {
            const api = deps.getApi();
            apiEventCleanupFn = wireApiEvents(api, deps.getUIWebContents);
            if (deps.pluginServer) {
              wirePluginApi(deps.pluginServer, api, deps.logger);
            }
            return {};
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              if (apiEventCleanupFn) {
                apiEventCleanupFn();
                apiEventCleanupFn = null;
              }
            } catch (error) {
              deps.logger.error(
                "IpcBridge lifecycle shutdown failed (non-fatal)",
                {},
                error instanceof Error ? error : undefined
              );
            }
          },
        },
      },
    },
  };
}
