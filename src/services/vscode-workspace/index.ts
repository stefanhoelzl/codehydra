/**
 * VS Code workspace file management.
 *
 * Creates and manages .code-workspace files for per-workspace VS Code settings.
 */

export { WorkspaceFileService } from "./workspace-file-service";
export { createWorkspaceFileConfig, DEFAULT_WORKSPACE_SETTINGS } from "./default-settings";
export type {
  IWorkspaceFileService,
  WorkspaceFileConfig,
  CodeWorkspaceFile,
  WorkspaceFolder,
  WorkspaceExtensions,
} from "./types";
