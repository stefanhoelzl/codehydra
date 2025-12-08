/**
 * IPC handler registration with type-safe wrappers and error serialization.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { IpcCommands, IpcEvents, UISetDialogModePayload } from "../../shared/ipc";
import { ValidationError, validate } from "./validation";
import { isServiceError } from "../../services/errors";
import type { IViewManager } from "../managers/view-manager.interface";

/**
 * Reference to the view manager for emitting events.
 */
let viewManagerRef: IViewManager | null = null;

/**
 * Serialized IPC error format for transport.
 */
interface IpcErrorResponse {
  readonly type: "git" | "workspace" | "code-server" | "project-store" | "validation" | "unknown";
  readonly message: string;
  readonly code?: string;
}

/**
 * Type for IPC handler functions.
 */
export type IpcHandler<K extends keyof IpcCommands> = (
  event: IpcMainInvokeEvent,
  payload: IpcCommands[K]["payload"]
) => Promise<IpcCommands[K]["response"]>;

/**
 * Serializes an error for IPC transport.
 *
 * @param error - The error to serialize
 * @returns Serialized error object
 */
export function serializeError(error: unknown): IpcErrorResponse {
  // ServiceError subclasses have toJSON
  if (isServiceError(error)) {
    return error.toJSON() as IpcErrorResponse;
  }

  // ValidationError from our validation module
  if (error instanceof ValidationError) {
    return error.toJSON();
  }

  // Standard Error - wrap as unknown
  if (error instanceof Error) {
    return {
      type: "unknown",
      message: error.message,
    };
  }

  // Non-Error values
  return {
    type: "unknown",
    message: "Unknown error",
  };
}

/**
 * Registers a type-safe IPC handler with validation and error serialization.
 *
 * @param channel - The IPC channel name
 * @param schema - Zod schema for payload validation (null for void payload)
 * @param handler - The handler function
 */
export function registerHandler<K extends keyof IpcCommands>(
  channel: K,
  schema: z.ZodSchema | null,
  handler: IpcHandler<K>
): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown) => {
    try {
      // Validate payload if schema provided
      const validatedPayload = schema ? validate(schema, payload) : payload;

      // Execute handler
      return await handler(event, validatedPayload as IpcCommands[K]["payload"]);
    } catch (error) {
      // Serialize and re-throw for IPC
      throw serializeError(error);
    }
  });
}

/**
 * Emits an event to the UI view.
 *
 * @param channel - The event channel name
 * @param payload - The event payload
 */
export function emitEvent<K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void {
  if (viewManagerRef) {
    viewManagerRef.getUIView().webContents.send(channel, payload);
  }
}

/**
 * Creates handler for ui:set-dialog-mode command.
 */
export function createUISetDialogModeHandler(
  viewManager: Pick<IViewManager, "setDialogMode">
): (event: IpcMainInvokeEvent, payload: UISetDialogModePayload) => Promise<void> {
  return async (_event, payload) => {
    viewManager.setDialogMode(payload.isOpen);
  };
}

/**
 * Creates handler for ui:focus-active-workspace command.
 */
export function createUIFocusActiveWorkspaceHandler(
  viewManager: Pick<IViewManager, "focusActiveWorkspace">
): (event: IpcMainInvokeEvent, payload: void) => Promise<void> {
  return async () => {
    viewManager.focusActiveWorkspace();
  };
}

// Import handlers and schemas
import {
  createProjectOpenHandler,
  createProjectCloseHandler,
  createProjectListHandler,
  createProjectSelectFolderHandler,
} from "./project-handlers";
import {
  createWorkspaceCreateHandler,
  createWorkspaceRemoveHandler,
  createWorkspaceSwitchHandler,
  createWorkspaceListBasesHandler,
  createWorkspaceUpdateBasesHandler,
  createWorkspaceIsDirtyHandler,
} from "./workspace-handlers";
import {
  createAgentGetStatusHandler,
  createAgentGetAllStatusesHandler,
  createAgentRefreshHandler,
} from "./agent-handlers";
import {
  ProjectOpenPayloadSchema,
  ProjectClosePayloadSchema,
  WorkspaceCreatePayloadSchema,
  WorkspaceRemovePayloadSchema,
  WorkspaceSwitchPayloadSchema,
  WorkspaceListBasesPayloadSchema,
  WorkspaceUpdateBasesPayloadSchema,
  WorkspaceIsDirtyPayloadSchema,
  UISetDialogModePayloadSchema,
  AgentGetStatusPayloadSchema,
} from "./validation";
import type { AppState } from "../app-state";

/**
 * Registers all IPC handlers for the application.
 *
 * @param appState - The application state manager
 * @param viewManager - The view manager
 */
export function registerAllHandlers(appState: AppState, viewManager: IViewManager): void {
  viewManagerRef = viewManager;

  // Project handlers
  registerHandler("project:open", ProjectOpenPayloadSchema, createProjectOpenHandler(appState));
  registerHandler("project:close", ProjectClosePayloadSchema, createProjectCloseHandler(appState));
  registerHandler("project:list", null, createProjectListHandler(appState));
  registerHandler("project:select-folder", null, createProjectSelectFolderHandler());

  // Workspace handlers
  registerHandler(
    "workspace:create",
    WorkspaceCreatePayloadSchema,
    createWorkspaceCreateHandler(appState, viewManager)
  );
  registerHandler(
    "workspace:remove",
    WorkspaceRemovePayloadSchema,
    createWorkspaceRemoveHandler(appState)
  );
  registerHandler(
    "workspace:switch",
    WorkspaceSwitchPayloadSchema,
    createWorkspaceSwitchHandler(appState, viewManager)
  );
  registerHandler(
    "workspace:list-bases",
    WorkspaceListBasesPayloadSchema,
    createWorkspaceListBasesHandler(appState)
  );
  registerHandler(
    "workspace:update-bases",
    WorkspaceUpdateBasesPayloadSchema,
    createWorkspaceUpdateBasesHandler(appState)
  );
  registerHandler(
    "workspace:is-dirty",
    WorkspaceIsDirtyPayloadSchema,
    createWorkspaceIsDirtyHandler(appState)
  );

  // UI handlers
  registerHandler(
    "ui:set-dialog-mode",
    UISetDialogModePayloadSchema,
    createUISetDialogModeHandler(viewManager)
  );
  registerHandler(
    "ui:focus-active-workspace",
    null,
    createUIFocusActiveWorkspaceHandler(viewManager)
  );

  // Agent status handlers
  const agentStatusManager = appState.getAgentStatusManager();
  const discoveryService = appState.getDiscoveryService();

  if (agentStatusManager) {
    registerHandler(
      "agent:get-status",
      AgentGetStatusPayloadSchema,
      createAgentGetStatusHandler(agentStatusManager)
    );
    registerHandler(
      "agent:get-all-statuses",
      null,
      createAgentGetAllStatusesHandler(agentStatusManager)
    );

    // Subscribe to status changes and emit IPC events
    agentStatusManager.onStatusChanged((workspacePath, status) => {
      emitEvent("agent:status-changed", { workspacePath, status });
    });
  }

  if (discoveryService) {
    registerHandler("agent:refresh", null, createAgentRefreshHandler(discoveryService));
  }
}
