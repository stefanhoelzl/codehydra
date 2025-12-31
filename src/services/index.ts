/**
 * Public API exports for the services layer.
 * All services are pure Node.js - no Electron dependencies.
 */

// Shared types
export type { IDisposable, Unsubscribe } from "../shared/types";

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
export type { Workspace, BaseInfo } from "./git/types";

// Git client
export type { IGitClient } from "./git/git-client";
export { SimpleGitClient } from "./git/simple-git-client";

// Workspace provider
export type { IWorkspaceProvider } from "./git/workspace-provider";
export { GitWorktreeProvider } from "./git/git-worktree-provider";

// Code server
export type { InstanceState, CodeServerConfig } from "./code-server/types";
export { CodeServerManager, urlForFolder } from "./code-server/code-server-manager";

// Project store
export type { ProjectConfig } from "./project/types";
export { CURRENT_PROJECT_VERSION } from "./project/types";
export { ProjectStore } from "./project/project-store";

// Platform utilities (pure functions - no build-mode dependencies)
export { sanitizeWorkspaceName, encodePathForUrl, projectDirName } from "./platform/paths";

// Path class for normalized cross-platform path handling
export { Path } from "./platform/path";

// Build info abstraction
export type { BuildInfo } from "./platform/build-info";
export { createMockBuildInfo } from "./platform/build-info.test-utils";

// Platform info abstraction
export type { PlatformInfo } from "./platform/platform-info";
export { createMockPlatformInfo } from "./platform/platform-info.test-utils";

// Workspace lock handler service
export type { WorkspaceLockHandler } from "./platform/workspace-lock-handler";
export {
  WindowsWorkspaceLockHandler,
  createWorkspaceLockHandler,
  UACCancelledError,
} from "./platform/workspace-lock-handler";
export { createMockWorkspaceLockHandler } from "./platform/workspace-lock-handler.test-utils";
export type {
  MockWorkspaceLockHandler,
  MockWorkspaceLockHandlerOptions,
} from "./platform/workspace-lock-handler.test-utils";

// Path provider abstraction
export type { PathProvider } from "./platform/path-provider";
export { DefaultPathProvider } from "./platform/path-provider";
export { createMockPathProvider } from "./platform/path-provider.test-utils";

// Process utilities
export {
  ExecaProcessRunner,
  PROCESS_KILL_GRACEFUL_TIMEOUT_MS,
  PROCESS_KILL_FORCE_TIMEOUT_MS,
} from "./platform/process";
export type {
  ProcessRunner,
  ProcessResult,
  ProcessOptions,
  SpawnedProcess,
  KillResult,
} from "./platform/process";

// Network layer
export { DefaultNetworkLayer } from "./platform/network";
export type {
  HttpClient,
  HttpRequestOptions,
  PortManager,
  NetworkLayerConfig,
} from "./platform/network";

// Filesystem layer
export { DefaultFileSystemLayer } from "./platform/filesystem";
export type {
  FileSystemLayer,
  DirEntry,
  MkdirOptions,
  RmOptions,
  FileSystemErrorCode,
  PathLike,
} from "./platform/filesystem";
export { createMockFileSystemLayer, createDirEntry } from "./platform/filesystem.test-utils";

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

// KeepFiles service
export { KeepFilesService } from "./keepfiles";
export type { IKeepFilesService, CopyResult, CopyError } from "./keepfiles";

// Logging service
export {
  ElectronLogService,
  createMockLogger,
  createMockLoggingService,
  SILENT_LOGGER,
} from "./logging";
export type {
  Logger,
  LoggingService,
  LogContext,
  LoggerName,
  LogLevel,
  MockLogger,
  MockLoggingService,
} from "./logging";

// Git worktree provider options
export type { GitWorktreeProviderOptions } from "./git/git-worktree-provider";

/**
 * Factory function to create a GitWorktreeProvider with a SimpleGitClient.
 *
 * @param projectRoot Absolute path to the git repository (Path)
 * @param workspacesDir Directory where worktrees will be created. Callers must obtain this
 *   from `PathProvider.getProjectWorkspacesDir(projectRoot)` to ensure consistent worktree placement.
 * @param fileSystemLayer FileSystemLayer for cleanup operations
 * @param gitLogger Logger for git client operations (typically "git")
 * @param worktreeLogger Logger for worktree provider operations (typically "worktree")
 * @param options Optional configuration including keepFilesService
 * @returns Promise resolving to an IWorkspaceProvider
 * @throws WorkspaceError if path is invalid or not a git repository
 */
export async function createGitWorktreeProvider(
  projectRoot: import("./platform/path").Path,
  workspacesDir: import("./platform/path").Path,
  fileSystemLayer: import("./platform/filesystem").FileSystemLayer,
  gitLogger: import("./logging").Logger,
  worktreeLogger: import("./logging").Logger,
  options?: import("./git/git-worktree-provider").GitWorktreeProviderOptions
): Promise<import("./git/workspace-provider").IWorkspaceProvider> {
  const { GitWorktreeProvider } = await import("./git/git-worktree-provider");
  const { SimpleGitClient } = await import("./git/simple-git-client");

  const gitClient = new SimpleGitClient(gitLogger);
  return GitWorktreeProvider.create(
    projectRoot,
    gitClient,
    workspacesDir,
    fileSystemLayer,
    worktreeLogger,
    options
  );
}
