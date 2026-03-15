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

// Types used by createGitWorktreeProvider
import type { Path } from "../utils/path/path";
import type { FileSystemLayer } from "../boundaries/platform/filesystem/filesystem";
import type { Logger } from "../boundaries/platform/logging";

// Git types
export type { Workspace, BaseInfo } from "../boundaries/platform/git/types";

// Git client
export type { IGitClient } from "../boundaries/platform/git/git-client";
import { SimpleGitClient } from "../boundaries/platform/git/simple-git-client";
export { SimpleGitClient };

// Workspace provider
import { GitWorktreeProvider } from "../boundaries/platform/git/git-worktree-provider";
export { GitWorktreeProvider };

// Project types
export type { ProjectConfig } from "./project/types";
export { CURRENT_PROJECT_VERSION } from "./project/types";

// Platform utilities (pure functions - no build-mode dependencies)
export {
  sanitizeWorkspaceName,
  encodePathForUrl,
  projectDirName,
} from "../boundaries/platform/env/paths";

// Path class for normalized cross-platform path handling
export { Path } from "../utils/path/path";

// Build info abstraction
export type { BuildInfo } from "../boundaries/platform/env/build-info";
export { createMockBuildInfo } from "../boundaries/platform/env/build-info.test-utils";

// Platform info abstraction
export type { PlatformInfo } from "../boundaries/platform/env/platform-info";
export { createMockPlatformInfo } from "../boundaries/platform/env/platform-info.test-utils";

// Path provider abstraction
export type { PathProvider, PathOptions } from "../boundaries/platform/env/path-provider";
export { DefaultPathProvider } from "../boundaries/platform/env/path-provider";
export { createMockPathProvider } from "../boundaries/platform/env/path-provider.test-utils";

// Process utilities
export {
  ExecaProcessRunner,
  PROCESS_KILL_GRACEFUL_TIMEOUT_MS,
  PROCESS_KILL_FORCE_TIMEOUT_MS,
} from "../boundaries/platform/process/process";
export type {
  ProcessRunner,
  ProcessResult,
  ProcessOptions,
  SpawnedProcess,
  KillResult,
} from "../boundaries/platform/process/process";

// Network layer
export { DefaultNetworkLayer } from "../boundaries/platform/network/network";
export type {
  HttpClient,
  HttpRequestOptions,
  PortManager,
  NetworkLayerConfig,
} from "../boundaries/platform/network/network";

// Filesystem layer
export { DefaultFileSystemLayer } from "../boundaries/platform/filesystem/filesystem";
export type {
  FileSystemLayer,
  DirEntry,
  MkdirOptions,
  RmOptions,
  FileSystemErrorCode,
  PathLike,
} from "../boundaries/platform/filesystem/filesystem";
export {
  createFileSystemMock,
  createSpyFileSystemLayer,
  createDirEntry,
  file,
  directory,
  symlink,
  type MockFileSystemLayer,
  type SpyFileSystemLayer,
  type Entry,
  type FileEntry,
  type DirectoryEntry,
  type SymlinkEntry,
} from "../boundaries/platform/filesystem/filesystem.state-mock";

// KeepFiles service
export { KeepFilesService } from "./keepfiles";
export type { IKeepFilesService, CopyResult, CopyError } from "./keepfiles";

// Logging service
export {
  ElectronLogService,
  parseLogLevel,
  parseLogLevelSpec,
  splitLogLevelSpec,
  createMockLogger,
  createMockLoggingService,
  SILENT_LOGGER,
} from "../boundaries/platform/logging";
export type {
  Logger,
  LoggingService,
  LoggingConfigureOptions,
  LogContext,
  LoggerName,
  LogLevel,
  LogOutput,
  MockLogger,
  MockLoggingService,
} from "../boundaries/platform/logging";

/**
 * Factory function to create a GitWorktreeProvider with a SimpleGitClient.
 * Validates the repository and registers the project.
 *
 * @param projectRoot Absolute path to the git repository (Path)
 * @param workspacesDir Directory where worktrees will be created. Callers must obtain this
 *   from `PathProvider.getProjectWorkspacesDir(projectRoot)` to ensure consistent worktree placement.
 * @param fileSystemLayer FileSystemLayer for cleanup operations
 * @param gitLogger Logger for git client operations (typically "git")
 * @param worktreeLogger Logger for worktree provider operations (typically "worktree")
 * @returns Promise resolving to a GitWorktreeProvider with the project registered
 * @throws WorkspaceError if path is invalid or not a git repository
 */
export async function createGitWorktreeProvider(
  projectRoot: Path,
  workspacesDir: Path,
  fileSystemLayer: FileSystemLayer,
  gitLogger: Logger,
  worktreeLogger: Logger
): Promise<GitWorktreeProvider> {
  const gitClient = new SimpleGitClient(gitLogger);
  const provider = new GitWorktreeProvider(gitClient, fileSystemLayer, worktreeLogger);

  // Validate it's a git repository root
  await provider.validateRepository(projectRoot);
  provider.registerProject(projectRoot, workspacesDir);

  return provider;
}
