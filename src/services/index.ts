/**
 * Public API exports for the services layer.
 * All services are pure Node.js - no Electron dependencies.
 */

// Error types
export {
  ServiceError,
  GitError,
  WorkspaceError,
  CodeServerError,
  ProjectStoreError,
  isServiceError,
} from "./errors";
export type { SerializedError } from "./errors";

// Git types
export type {
  WorktreeInfo,
  BranchInfo,
  StatusResult,
  Workspace,
  BaseInfo,
  RemovalResult,
  UpdateBasesResult,
} from "./git/types";

// Git client
export type { IGitClient } from "./git/git-client";
export { SimpleGitClient } from "./git/simple-git-client";

// Workspace provider
export type { IWorkspaceProvider } from "./git/workspace-provider";
export { GitWorktreeProvider } from "./git/git-worktree-provider";

// Code server
export type { InstanceState, CodeServerConfig, CodeServerInfo } from "./code-server/types";
export { CodeServerManager, urlForFolder } from "./code-server/code-server-manager";

// Project store
export type { ProjectConfig } from "./project/types";
export { CURRENT_PROJECT_VERSION } from "./project/types";
export { ProjectStore } from "./project/project-store";

// Platform utilities
export {
  getDataRootDir,
  getDataProjectsDir,
  getProjectWorkspacesDir,
  getVscodeDir,
  getVscodeExtensionsDir,
  getVscodeUserDataDir,
  getVscodeSetupMarkerPath,
  sanitizeWorkspaceName,
  unsanitizeWorkspaceName,
  encodePathForUrl,
  projectDirName,
} from "./platform/paths";
export { findAvailablePort, spawnProcess } from "./platform/process";
export type { SpawnProcessOptions } from "./platform/process";

// VSCode setup
export { VscodeSetupService, CURRENT_SETUP_VERSION } from "./vscode-setup";
export type {
  IVscodeSetup,
  SetupResult,
  SetupError,
  SetupStep,
  SetupProgress,
  ProgressCallback,
  SetupMarker,
  ProcessRunner,
  ProcessResult,
} from "./vscode-setup";

/**
 * Factory function to create a GitWorktreeProvider with a SimpleGitClient.
 *
 * @param projectRoot Absolute path to the git repository
 * @returns Promise resolving to an IWorkspaceProvider
 * @throws WorkspaceError if path is invalid or not a git repository
 */
export async function createGitWorktreeProvider(
  projectRoot: string
): Promise<import("./git/workspace-provider").IWorkspaceProvider> {
  const { GitWorktreeProvider } = await import("./git/git-worktree-provider");
  const { SimpleGitClient } = await import("./git/simple-git-client");

  const gitClient = new SimpleGitClient();
  return GitWorktreeProvider.create(projectRoot, gitClient);
}
