/**
 * IpcEventBridge - Bridges domain events to the ApiRegistry event system,
 * manages IPC lifecycle (API event wiring, plugin API), and registers all
 * API bridge handlers in the registry.
 *
 * This is an IntentModule that:
 * 1. Subscribes to domain events and forwards them to ApiRegistry.emit() for IPC
 * 2. On app:start, wires API events to IPC and sets up the Plugin API
 * 3. On app:shutdown, cleans up event subscriptions
 * 4. Manages plugin workspace registration on workspace created/deleted events
 * 5. Registers all dispatcher bridge handlers in the API registry
 */

import type { WebContents } from "electron";
import type { IntentModule, EventDeclarations } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import type {
  IApiRegistry,
  ProjectOpenPayload,
  ProjectClosePayload,
  ProjectClonePayload,
  ProjectIdPayload,
  WorkspaceCreatePayload,
  WorkspaceRemovePayload,
  WorkspaceSetMetadataPayload,
  WorkspacePathPayload,
  WorkspaceExecuteCommandPayload,
  UiSwitchWorkspacePayload,
  UiSetModePayload,
  EmptyPayload,
} from "../api/registry-types";
import type { ICodeHydraApi, Unsubscribe } from "../../shared/api/interfaces";
import type { Logger } from "../../services/logging";
import type { PluginServer } from "../../services/plugin-server";
import type { StartHookResult } from "../operations/app-start";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { wireApiEvents } from "../ipc/api-handlers";
import { wirePluginApi } from "../api/wire-plugin-api";
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
import type { ProjectOpenedEvent } from "../operations/open-project";
import { EVENT_PROJECT_OPENED, INTENT_OPEN_PROJECT } from "../operations/open-project";
import type { OpenProjectIntent } from "../operations/open-project";
import type { ProjectClosedEvent } from "../operations/close-project";
import { EVENT_PROJECT_CLOSED, INTENT_CLOSE_PROJECT } from "../operations/close-project";
import type { CloseProjectIntent } from "../operations/close-project";
import type { WorkspaceSwitchedEvent } from "../operations/switch-workspace";
import { EVENT_WORKSPACE_SWITCHED, INTENT_SWITCH_WORKSPACE } from "../operations/switch-workspace";
import type { SwitchWorkspaceIntent } from "../operations/switch-workspace";
import type { AgentStatusUpdatedEvent } from "../operations/update-agent-status";
import { EVENT_AGENT_STATUS_UPDATED } from "../operations/update-agent-status";
import { EVENT_SETUP_ERROR, EVENT_SETUP_PROGRESS } from "../operations/setup";
import type { SetupErrorEvent, SetupProgressEvent } from "../operations/setup";
import type { SetupErrorPayload, WorkspacePath } from "../../shared/ipc";
import { ApiIpcChannels } from "../../shared/ipc";
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
import type { GitWorktreeProvider } from "../../services/git/git-worktree-provider";
import { Path } from "../../services/platform/path";
import { expandGitUrl } from "../../services/project/url-utils";

/**
 * Dependencies for the IpcEventBridge module.
 */
export interface IpcEventBridgeDeps {
  readonly apiRegistry: IApiRegistry;
  readonly getApi: () => ICodeHydraApi;
  readonly getUIWebContents: () => WebContents | null;
  readonly pluginServer: PluginServer | null;
  readonly logger: Logger;

  // Dependencies for bridge handlers
  readonly dispatcher: Dispatcher;
  readonly agentStatusManager: {
    getStatus(wp: WorkspacePath): { status: string } | undefined;
  };
  readonly globalWorktreeProvider: GitWorktreeProvider;
  readonly deleteOp: {
    hasPendingRetry(wp: string): boolean;
    signalDismiss(wp: string): void;
    signalRetry(wp: string): void;
  };
}

/**
 * Create an IpcEventBridge module that forwards domain events to the API registry,
 * manages IPC lifecycle (API event wiring, plugin API), and registers all
 * API bridge handlers.
 *
 * @param deps - Module dependencies
 * @returns IntentModule with event subscriptions and lifecycle hooks
 */
export function createIpcEventBridge(deps: IpcEventBridgeDeps): IntentModule {
  const { apiRegistry, dispatcher, logger } = deps;

  // Closure state for lifecycle management
  let apiEventCleanupFn: Unsubscribe | null = null;

  // Closure state for deduplicating in-progress project opens/clones
  const inProgressOpens = new Set<string>();

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
    [EVENT_WORKSPACE_DELETION_PROGRESS]: (event: DomainEvent) => {
      const progress = (event as WorkspaceDeletionProgressEvent).payload;
      try {
        const webContents = deps.getUIWebContents();
        if (webContents && !webContents.isDestroyed()) {
          webContents.send(ApiIpcChannels.WORKSPACE_DELETION_PROGRESS, progress);
        }
      } catch {
        // Ignore - deletion continues even if UI disconnected
      }
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

  // ---------------------------------------------------------------------------
  // Register dispatcher bridge handlers in the API registry
  // ---------------------------------------------------------------------------

  apiRegistry.register(
    "lifecycle.quit",
    async () => {
      logger.debug("Quit requested");
      await dispatcher.dispatch({
        type: INTENT_APP_SHUTDOWN,
        payload: {},
      } as AppShutdownIntent);
    },
    { ipc: ApiIpcChannels.LIFECYCLE_QUIT }
  );

  apiRegistry.register(
    "workspaces.create",
    async (payload: WorkspaceCreatePayload) => {
      const intent: OpenWorkspaceIntent = {
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          ...(payload.projectId !== undefined && { projectId: payload.projectId }),
          workspaceName: payload.name,
          base: payload.base,
          ...(payload.initialPrompt !== undefined && { initialPrompt: payload.initialPrompt }),
          ...(payload.keepInBackground !== undefined && {
            keepInBackground: payload.keepInBackground,
          }),
          ...(payload.callerWorkspacePath !== undefined && {
            callerWorkspacePath: payload.callerWorkspacePath,
          }),
        },
      };
      const result = await dispatcher.dispatch(intent);
      if (!result) {
        throw new Error("Create workspace dispatch returned no result");
      }
      return result as Workspace;
    },
    { ipc: ApiIpcChannels.WORKSPACE_CREATE }
  );

  apiRegistry.register(
    "workspaces.remove",
    async (payload: WorkspaceRemovePayload) => {
      // If pipeline is waiting for user choice, signal it instead of dispatching new intent.
      if (deps.deleteOp.hasPendingRetry(payload.workspacePath)) {
        if (payload.force) {
          deps.deleteOp.signalDismiss(payload.workspacePath);
          // Fall through to dispatch force intent after pipeline exits
        } else {
          deps.deleteOp.signalRetry(payload.workspacePath);
          return { started: true };
        }
      }

      const intent: DeleteWorkspaceIntent = {
        type: INTENT_DELETE_WORKSPACE,
        payload: {
          workspacePath: payload.workspacePath,
          keepBranch: payload.keepBranch ?? true,
          force: payload.force ?? false,
          removeWorktree: true,
          ...(payload.skipSwitch !== undefined && { skipSwitch: payload.skipSwitch }),
        },
      };

      // Dispatch and check interceptor result (idempotency check happens inside pipeline)
      const handle = dispatcher.dispatch(intent);
      if (!(await handle.accepted)) {
        return { started: false };
      }
      // Fire-and-forget the operation result (deletion runs asynchronously)
      void handle;
      return { started: true };
    },
    { ipc: ApiIpcChannels.WORKSPACE_REMOVE }
  );

  apiRegistry.register(
    "workspaces.setMetadata",
    async (payload: WorkspaceSetMetadataPayload) => {
      const intent: SetMetadataIntent = {
        type: INTENT_SET_METADATA,
        payload: {
          workspacePath: payload.workspacePath,
          key: payload.key,
          value: payload.value,
        },
      };
      await dispatcher.dispatch(intent);
    },
    { ipc: ApiIpcChannels.WORKSPACE_SET_METADATA }
  );

  apiRegistry.register(
    "workspaces.getMetadata",
    async (payload: WorkspacePathPayload) => {
      const intent: GetMetadataIntent = {
        type: INTENT_GET_METADATA,
        payload: {
          workspacePath: payload.workspacePath,
        },
      };
      const result = await dispatcher.dispatch(intent);
      if (!result) {
        throw new Error("Get metadata dispatch returned no result");
      }
      return result;
    },
    { ipc: ApiIpcChannels.WORKSPACE_GET_METADATA }
  );

  apiRegistry.register(
    "workspaces.getStatus",
    async (payload: WorkspacePathPayload) => {
      const intent: GetWorkspaceStatusIntent = {
        type: INTENT_GET_WORKSPACE_STATUS,
        payload: {
          workspacePath: payload.workspacePath,
        },
      };
      const result = await dispatcher.dispatch(intent);
      if (!result) {
        throw new Error("Get workspace status dispatch returned no result");
      }
      return result;
    },
    { ipc: ApiIpcChannels.WORKSPACE_GET_STATUS }
  );

  apiRegistry.register(
    "workspaces.getAgentSession",
    async (payload: WorkspacePathPayload) => {
      const intent: GetAgentSessionIntent = {
        type: INTENT_GET_AGENT_SESSION,
        payload: {
          workspacePath: payload.workspacePath,
        },
      };
      return dispatcher.dispatch(intent);
    },
    { ipc: ApiIpcChannels.WORKSPACE_GET_AGENT_SESSION }
  );

  apiRegistry.register(
    "workspaces.restartAgentServer",
    async (payload: WorkspacePathPayload) => {
      const intent: RestartAgentIntent = {
        type: INTENT_RESTART_AGENT,
        payload: {
          workspacePath: payload.workspacePath,
        },
      };
      const result = await dispatcher.dispatch(intent);
      if (result === undefined) {
        throw new Error("Restart agent dispatch returned no result");
      }
      return result;
    },
    { ipc: ApiIpcChannels.WORKSPACE_RESTART_AGENT_SERVER }
  );

  apiRegistry.register(
    "ui.setMode",
    async (payload: UiSetModePayload) => {
      const intent: SetModeIntent = {
        type: INTENT_SET_MODE,
        payload: {
          mode: payload.mode,
        },
      };
      await dispatcher.dispatch(intent);
    },
    { ipc: ApiIpcChannels.UI_SET_MODE }
  );

  apiRegistry.register(
    "ui.getActiveWorkspace",
    async (payload: EmptyPayload) => {
      void payload;
      const intent: GetActiveWorkspaceIntent = {
        type: INTENT_GET_ACTIVE_WORKSPACE,
        payload: {} as Record<string, never>,
      };
      return dispatcher.dispatch(intent);
    },
    { ipc: ApiIpcChannels.UI_GET_ACTIVE_WORKSPACE }
  );

  apiRegistry.register(
    "ui.switchWorkspace",
    async (payload: UiSwitchWorkspacePayload) => {
      const intent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: {
          workspacePath: payload.workspacePath,
          ...(payload.focus !== undefined && { focus: payload.focus }),
        },
      };
      await dispatcher.dispatch(intent);
    },
    { ipc: ApiIpcChannels.UI_SWITCH_WORKSPACE }
  );

  // ---------------------------------------------------------------------------
  // Project API bridge handlers
  // ---------------------------------------------------------------------------

  apiRegistry.register(
    "projects.open",
    async (payload: ProjectOpenPayload) => {
      // When path is provided, deduplicate in-progress opens
      const key = payload.path ? new Path(payload.path).toString() : null;
      if (key) {
        if (inProgressOpens.has(key)) {
          throw new Error("Project open already in progress");
        }
        inProgressOpens.add(key);
      }
      try {
        const intent: OpenProjectIntent = {
          type: INTENT_OPEN_PROJECT,
          payload: {
            ...(payload.path !== undefined && { path: new Path(payload.path) }),
          },
        };
        return await dispatcher.dispatch(intent);
      } finally {
        if (key) {
          inProgressOpens.delete(key);
        }
      }
    },
    { ipc: ApiIpcChannels.PROJECT_OPEN }
  );

  apiRegistry.register(
    "projects.clone",
    async (payload: ProjectClonePayload) => {
      const key = expandGitUrl(payload.url);
      if (inProgressOpens.has(key)) {
        throw new Error("Clone already in progress");
      }
      inProgressOpens.add(key);
      try {
        const intent: OpenProjectIntent = {
          type: INTENT_OPEN_PROJECT,
          payload: { git: payload.url },
        };
        const result = await dispatcher.dispatch(intent);
        if (!result) {
          throw new Error("Clone project dispatch returned no result");
        }
        return result;
      } finally {
        inProgressOpens.delete(key);
      }
    },
    { ipc: ApiIpcChannels.PROJECT_CLONE }
  );

  apiRegistry.register(
    "projects.close",
    async (payload: ProjectClosePayload) => {
      const intent: CloseProjectIntent = {
        type: INTENT_CLOSE_PROJECT,
        payload: {
          projectId: payload.projectId,
          ...(payload.removeLocalRepo !== undefined && {
            removeLocalRepo: payload.removeLocalRepo,
          }),
        },
      };
      await dispatcher.dispatch(intent);
    },
    { ipc: ApiIpcChannels.PROJECT_CLOSE }
  );

  apiRegistry.register(
    "projects.fetchBases",
    async (payload: ProjectIdPayload) => {
      // Dispatch workspace:open with incomplete payload (missing workspaceName/base)
      // This triggers the resolve-project + fetch-bases path
      const intent: OpenWorkspaceIntent = {
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          projectId: payload.projectId,
        },
      };
      const result = await dispatcher.dispatch(intent);
      if (!result) {
        throw new Error("Fetch bases dispatch returned no result");
      }
      const basesResult = result as {
        bases: readonly { name: string; isRemote: boolean }[];
        defaultBaseBranch?: string;
        projectPath: string;
      };

      // Fire-and-forget background update
      void (async () => {
        try {
          const projectRoot = new Path(basesResult.projectPath);
          await deps.globalWorktreeProvider.updateBases(projectRoot);
          const updatedBases = await deps.globalWorktreeProvider.listBases(projectRoot);
          apiRegistry.emit("project:bases-updated", {
            projectId: payload.projectId,
            bases: updatedBases,
          });
        } catch (error) {
          logger.error(
            "Failed to fetch bases for project",
            { projectId: payload.projectId },
            error instanceof Error ? error : undefined
          );
        }
      })();

      return { bases: basesResult.bases };
    },
    { ipc: ApiIpcChannels.PROJECT_FETCH_BASES }
  );

  // executeCommand is not exposed via IPC (only used by MCP/Plugin)
  apiRegistry.register(
    "workspaces.executeCommand",
    async (payload: WorkspaceExecuteCommandPayload) => {
      if (!deps.pluginServer) {
        throw new Error("Plugin server not available");
      }
      const result = await deps.pluginServer.sendCommand(
        payload.workspacePath,
        payload.command,
        payload.args
      );
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data;
    }
  );

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
