/**
 * Test utilities for GitWorktreeProvider tests.
 */
import { GitWorktreeProvider } from "./git-worktree-provider";
import { createMockGitClient } from "./git-client.state-mock";
import type { MockGitClient, RepositoryInit } from "./git-client.state-mock";
import type { MockFileSystemBoundary } from "./filesystem.state-mock";
import { SILENT_LOGGER } from "./logging";
import type { IGitClient } from "./git-client";
import type { FileSystemBoundary } from "./filesystem";
import type { Logger } from "./logging";
import type { Path } from "../../utils/path/path";

/** Construct a provider the way production does: new + validateRepository + registerProject. */
export async function createProvider(
  projectRoot: Path,
  gitClient: IGitClient,
  workspacesDir: Path,
  fileSystemLayer: FileSystemBoundary,
  logger: Logger
): Promise<GitWorktreeProvider> {
  const provider = new GitWorktreeProvider(gitClient, fileSystemLayer, logger);
  await provider.validateRepository(projectRoot);
  provider.registerProject(projectRoot, workspacesDir);
  return provider;
}

/** A repository whose main worktree is on `main`, its only branch. */
export const MAIN_ONLY: RepositoryInit = { branches: ["main"], currentBranch: "main" };

/**
 * Helpers bound to one test project: a mock git client holding only that
 * repository, and a provider over it built by {@link createProvider}.
 */
export function testProject(projectRoot: Path, workspacesDir: Path) {
  return {
    gitRepo: (init: RepositoryInit, fileSystem?: MockFileSystemBoundary): MockGitClient =>
      createMockGitClient({
        ...(fileSystem && { fileSystem }),
        repositories: { [projectRoot.toString()]: init },
      }),
    providerFor: (
      client: IGitClient,
      fileSystemLayer: FileSystemBoundary,
      logger: Logger = SILENT_LOGGER
    ): Promise<GitWorktreeProvider> =>
      createProvider(projectRoot, client, workspacesDir, fileSystemLayer, logger),
  };
}
