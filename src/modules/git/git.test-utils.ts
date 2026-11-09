/**
 * The git module for tests: every dependency defaults to a behavioral mock, so
 * a test overrides only what it looks at.
 */

import { vi, type Mock } from "vitest";
import type { GitWorktreeProvider } from "../../boundaries/platform/git-worktree-provider";
import { createMockGitClient } from "../../boundaries/platform/git-client.state-mock";
import { createFileSystemMock } from "../../boundaries/platform/filesystem.state-mock";
import { SILENT_LOGGER } from "../../boundaries/platform/logging";
import { Path } from "../../utils/path/path";
import { testPath } from "../../shared/test-fixtures";
import { createMockDialogManager } from "../presentation/dialog-manager.state-mock";
import { createMockNotificationManager } from "../presentation/notification-manager.state-mock";
import { createTestWorkspaceRegistry, TEST_PROJECTS_DIR } from "../workspace-registry.test-utils";
import { createGitProjectModule, type GitProjectModule, type GitProjectModuleDeps } from "./module";

/** The GitWorktreeProvider methods the git module calls, each a spy. */
export interface MockGitWorktreeProvider {
  readonly registerProject: Mock;
  readonly unregisterProject: Mock;
  readonly discover: Mock;
  readonly createWorkspace: Mock;
  readonly removeWorkspace: Mock;
  readonly isDirty: Mock;
  readonly countUnmergedCommits: Mock;
  readonly listBases: Mock;
  readonly defaultBase: Mock;
  readonly updateBases: Mock;
  readonly cleanupOrphanedWorkspaces: Mock;
  readonly validateRepository: Mock;
  readonly ensureWorkspaceRegistered: Mock;
  readonly listUnmanagedWorktrees: Mock;
  readonly adoptWorktree: Mock;
  readonly metadataFileOf: Mock<(worktreePath: Path) => Promise<Path>>;
}

/** A GitWorktreeProvider whose every method is a spy with a harmless default. */
export function createMockGitWorktreeProvider(): MockGitWorktreeProvider {
  return {
    registerProject: vi.fn(),
    unregisterProject: vi.fn(),
    discover: vi.fn().mockResolvedValue([]),
    createWorkspace: vi.fn(),
    removeWorkspace: vi.fn().mockResolvedValue({ workspaceRemoved: true, baseDeleted: false }),
    isDirty: vi.fn().mockResolvedValue(false),
    countUnmergedCommits: vi.fn().mockResolvedValue(0),
    listBases: vi.fn().mockResolvedValue([]),
    defaultBase: vi.fn().mockResolvedValue(undefined),
    updateBases: vi.fn().mockResolvedValue(undefined),
    cleanupOrphanedWorkspaces: vi.fn().mockResolvedValue({ removedCount: 0, failedPaths: [] }),
    validateRepository: vi.fn().mockResolvedValue(undefined),
    ensureWorkspaceRegistered: vi.fn(),
    listUnmanagedWorktrees: vi.fn().mockResolvedValue([]),
    adoptWorktree: vi.fn().mockResolvedValue(undefined),
    // Where a worktree's metadata file is: the test registry's directory.
    metadataFileOf: vi.fn(
      async (worktreePath: Path) => new Path(TEST_PROJECTS_DIR, `${worktreePath.basename}.json`)
    ),
  };
}

/** The git module's dependencies, with the worktree provider as its mock type. */
export type TestGitModuleDeps = Omit<GitProjectModuleDeps, "gitWorktreeProvider"> & {
  readonly gitWorktreeProvider: MockGitWorktreeProvider | Partial<MockGitWorktreeProvider>;
};

/** The git module over mocks; `overrides` replace the defaults one by one. */
export function createTestGitModule(overrides: Partial<TestGitModuleDeps> = {}): GitProjectModule {
  const defaults: TestGitModuleDeps = {
    projectsDir: testPath("/test/app-data/projects").toNative(),
    workspacesRoot: {
      remotesDir: () => testPath("/test/app-data/remotes"),
      workspacesDir: () => testPath("/workspaces"),
      previousWorkspacesDirs: () => [],
    },
    fs: createFileSystemMock(),
    store: { records: async () => [], isOpen: () => false },
    registry: createTestWorkspaceRegistry().registry,
    gitWorktreeProvider: createMockGitWorktreeProvider(),
    gitClient: createMockGitClient(),
    ui: createMockDialogManager().ui,
    dispatcher: createMockNotificationManager().dispatcher,
    logger: SILENT_LOGGER,
    workspaceLogger: SILENT_LOGGER,
  };
  const deps = { ...defaults, ...overrides };
  return createGitProjectModule({
    ...deps,
    // Every method a test reaches is mocked; the rest are never called.
    gitWorktreeProvider: {
      ...createMockGitWorktreeProvider(),
      ...deps.gitWorktreeProvider,
    } as unknown as GitWorktreeProvider,
  });
}
