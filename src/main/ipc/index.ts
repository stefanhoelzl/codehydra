/**
 * Barrel export for IPC modules.
 */

export { registerHandler, registerAllHandlers, serializeError, emitEvent } from "./handlers";
export type { IpcHandler } from "./handlers";

export {
  createProjectOpenHandler,
  createProjectCloseHandler,
  createProjectListHandler,
  createProjectSelectFolderHandler,
} from "./project-handlers";

export {
  createWorkspaceCreateHandler,
  createWorkspaceRemoveHandler,
  createWorkspaceSwitchHandler,
  createWorkspaceListBasesHandler,
  createWorkspaceUpdateBasesHandler,
  createWorkspaceIsDirtyHandler,
} from "./workspace-handlers";

export {
  ValidationError,
  validate,
  absolutePathSchema,
  ProjectOpenPayloadSchema,
  ProjectClosePayloadSchema,
  WorkspaceCreatePayloadSchema,
  WorkspaceRemovePayloadSchema,
  WorkspaceSwitchPayloadSchema,
  WorkspaceListBasesPayloadSchema,
  WorkspaceUpdateBasesPayloadSchema,
  WorkspaceIsDirtyPayloadSchema,
} from "./validation";

export {
  createSetupReadyHandler,
  createSetupStartHandler,
  createSetupRetryHandler,
  createSetupQuitHandler,
  type SetupEventEmitters,
} from "./setup-handlers";
