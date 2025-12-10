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

// Platform utilities (pure functions - no build-mode dependencies)
export {
  sanitizeWorkspaceName,
  unsanitizeWorkspaceName,
  encodePathForUrl,
  projectDirName,
} from "./platform/paths";

// Build info abstraction
export type { BuildInfo } from "./platform/build-info";
export { createMockBuildInfo } from "./platform/build-info.test-utils";

// Platform info abstraction
export type { PlatformInfo } from "./platform/platform-info";
export { createMockPlatformInfo } from "./platform/platform-info.test-utils";

// Path provider abstraction
export type { PathProvider } from "./platform/path-provider";
export { DefaultPathProvider } from "./platform/path-provider";
export { createMockPathProvider } from "./platform/path-provider.test-utils";

// Process utilities
export { ExecaProcessRunner } from "./platform/process";
export type {
  ProcessRunner,
  ProcessResult,
  ProcessOptions,
  SpawnedProcess,
} from "./platform/process";

// Network layer
export { DefaultNetworkLayer } from "./platform/network";
export type {
  HttpClient,
  HttpRequestOptions,
  SseClient,
  SseConnection,
  SseConnectionOptions,
  PortManager,
  ListeningPort,
  NetworkLayerConfig,
} from "./platform/network";

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
} from "./vscode-setup";
// Note: ProcessRunner and ProcessResult are exported from platform/process.
// VscodeSetupService uses ProcessRunner via vscode-setup/types.ts re-export.

/**
 * Factory function to create a GitWorktreeProvider with a SimpleGitClient.
 *
 * @param projectRoot Absolute path to the git repository
 * @param workspacesDir Directory where worktrees will be created. Callers must obtain this
 *   from `PathProvider.getProjectWorkspacesDir(projectRoot)` to ensure consistent worktree placement.
 * @returns Promise resolving to an IWorkspaceProvider
 * @throws WorkspaceError if path is invalid or not a git repository
 */
export async function createGitWorktreeProvider(
  projectRoot: string,
  workspacesDir: string
): Promise<import("./git/workspace-provider").IWorkspaceProvider> {
  const { GitWorktreeProvider } = await import("./git/git-worktree-provider");
  const { SimpleGitClient } = await import("./git/simple-git-client");

  const gitClient = new SimpleGitClient();
  return GitWorktreeProvider.create(projectRoot, gitClient, workspacesDir);
}
