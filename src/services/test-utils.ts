/**
 * Test utilities for service tests.
 * These helpers create temporary directories and git repositories
 * with automatic cleanup.
 */

import { mkdtemp, rm, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { simpleGit } from "simple-git";
import { vi } from "vitest";
import type { IWorkspaceApi, IProjectApi, ICoreApi } from "../shared/api/interfaces";
import { MOCK_WORKSPACE_API_DEFAULTS } from "../shared/test-fixtures";

/**
 * Create a temporary directory with automatic cleanup.
 * Uses realpath to resolve Windows 8.3 short paths (e.g., RUNNER~1 -> runneradmin).
 * @returns Object with path and cleanup function
 */
export async function createTempDir(): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const tempPath = await mkdtemp(join(tmpdir(), "codehydra-test-"));
  // Resolve to canonical path - this fixes Windows 8.3 short paths (e.g., RUNNER~1)
  // that can cause path comparison mismatches in tests
  const resolvedPath = await realpath(tempPath);
  return {
    path: resolvedPath,
    cleanup: async () => {
      await rm(resolvedPath, {
        recursive: true,
        force: true,
        // Retry on EBUSY/EPERM errors - file handles may take time to release after process termination
        maxRetries: 5,
        retryDelay: 200,
      });
    },
  };
}

export interface CreateTestGitRepoOptions {
  /** Create these worktrees (branch names) */
  worktrees?: string[];
  /** Add uncommitted changes to working directory */
  dirty?: boolean;
  /** Detach HEAD */
  detached?: boolean;
}

/**
 * Create a git repository for testing with optional configuration.
 * @param options Repository configuration
 * @returns Object with path and cleanup function
 */
export async function createTestGitRepo(options: CreateTestGitRepoOptions = {}): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const { path, cleanup } = await createTempDir();

  const git = simpleGit(path);

  // Initialize repository with explicit branch name for cross-platform consistency
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test User");

  // Create initial commit (required for worktrees)
  const { writeFile } = await import("fs/promises");
  await writeFile(join(path, "README.md"), "# Test Repository\n");
  await git.add("README.md");
  await git.commit("Initial commit");

  // Create worktrees if requested
  if (options.worktrees && options.worktrees.length > 0) {
    for (const branchName of options.worktrees) {
      // Create branch first
      await git.branch([branchName]);

      // Create worktree directory
      const worktreePath = join(path, ".worktrees", branchName);
      await git.raw(["worktree", "add", worktreePath, branchName]);
    }
  }

  // Add dirty changes if requested
  if (options.dirty) {
    await writeFile(join(path, "dirty-file.txt"), "uncommitted changes\n");
  }

  // Detach HEAD if requested
  if (options.detached) {
    const log = await git.log(["-1"]);
    await git.checkout(log.latest!.hash);
  }

  return { path, cleanup };
}

/**
 * Run a test function with a temporary git repository.
 * The repository is automatically cleaned up after the test,
 * even if the test fails.
 *
 * @param fn Test function that receives the repo path
 * @param options Repository configuration
 */
export async function withTempRepo(
  fn: (repoPath: string) => Promise<void>,
  options: CreateTestGitRepoOptions = {}
): Promise<void> {
  const { path, cleanup } = await createTestGitRepo(options);
  try {
    await fn(path);
  } finally {
    await cleanup();
  }
}

/**
 * Run a test function with a temporary directory.
 * The directory is automatically cleaned up after the test,
 * even if the test fails.
 *
 * @param fn Test function that receives the directory path
 */
export async function withTempDir(fn: (dirPath: string) => Promise<void>): Promise<void> {
  const { path, cleanup } = await createTempDir();
  try {
    await fn(path);
  } finally {
    await cleanup();
  }
}

/**
 * Result from creating a test git repo with a remote.
 */
export interface TestRepoWithRemoteResult {
  /** Working repo path */
  path: string;
  /** Bare remote path */
  remotePath: string;
  /** Cleanup function that removes both directories */
  cleanup: () => Promise<void>;
}

/**
 * Create a git repository with a local bare remote for testing.
 * The remote is configured as 'origin' and main is pushed.
 *
 * Structure:
 * - /tmp/codehydra-test-xxx/repo/      - Working directory
 * - /tmp/codehydra-test-xxx/remote.git - Bare remote
 *
 * @returns Object with paths and cleanup function
 */
export async function createTestGitRepoWithRemote(): Promise<TestRepoWithRemoteResult> {
  // Create parent temp directory
  const parent = await mkdtemp(join(tmpdir(), "codehydra-test-"));
  const repoPath = join(parent, "repo");
  const remotePath = join(parent, "remote.git");

  const { mkdir, writeFile } = await import("fs/promises");

  // Create bare remote first
  await mkdir(remotePath);
  const remoteGit = simpleGit(remotePath);
  await remoteGit.init(true); // bare=true

  // Create working repo
  await mkdir(repoPath);
  const git = simpleGit(repoPath);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test User");

  // Create initial commit
  await writeFile(join(repoPath, "README.md"), "# Test Repository\n");
  await git.add("README.md");
  await git.commit("Initial commit");

  // Add remote and push
  await git.addRemote("origin", "../remote.git");
  await git.push(["-u", "origin", "main"]);

  return {
    path: repoPath,
    remotePath,
    cleanup: async () => {
      await rm(parent, { recursive: true, force: true });
    },
  };
}

/**
 * Create a commit directly in a bare repository.
 * This is useful for testing fetch operations.
 *
 * @param remotePath Path to the bare repository
 * @param message Commit message
 */
export async function createCommitInRemote(remotePath: string, message: string): Promise<void> {
  // Create a temporary clone, make a commit, push, cleanup
  const tempClone = await mkdtemp(join(tmpdir(), "codehydra-clone-"));

  try {
    const git = simpleGit(tempClone);
    // Explicitly checkout main branch for cross-platform consistency
    await git.clone(remotePath, ".", ["--branch", "main"]);
    await git.addConfig("user.email", "test@test.com");
    await git.addConfig("user.name", "Test User");

    const { writeFile } = await import("fs/promises");
    const filename = `file-${Date.now()}.txt`;
    await writeFile(join(tempClone, filename), `Content: ${message}\n`);
    await git.add(filename);
    await git.commit(message);
    await git.push();
  } finally {
    await rm(tempClone, { recursive: true, force: true });
  }
}

/**
 * Run a test function with a temporary git repository and remote.
 * Both are automatically cleaned up after the test, even if the test fails.
 *
 * @param fn Test function that receives the repo path and remote path
 */
export async function withTempRepoWithRemote(
  fn: (repoPath: string, remotePath: string) => Promise<void>
): Promise<void> {
  const { path, remotePath, cleanup } = await createTestGitRepoWithRemote();
  try {
    await fn(path, remotePath);
  } finally {
    await cleanup();
  }
}

/**
 * Suppress console output during a test that is expected to produce console output.
 * Use this when testing error handling code that logs to console.
 *
 * @param methods Console methods to suppress (default: ["error", "warn"])
 * @returns Object with restore function to call in afterEach/finally
 *
 * @example
 * ```ts
 * it("handles error gracefully", () => {
 *   const console = suppressConsole();
 *   try {
 *     // Code that calls console.error
 *     expect(console.error).toHaveBeenCalled();
 *   } finally {
 *     console.restore();
 *   }
 * });
 * ```
 */
export function suppressConsole(
  methods: Array<"error" | "warn" | "log" | "info" | "debug"> = ["error", "warn"]
): {
  error: ReturnType<typeof vi.spyOn>;
  warn: ReturnType<typeof vi.spyOn>;
  log: ReturnType<typeof vi.spyOn>;
  info: ReturnType<typeof vi.spyOn>;
  debug: ReturnType<typeof vi.spyOn>;
  restore: () => void;
} {
  const spies = {
    error: vi.spyOn(console, "error"),
    warn: vi.spyOn(console, "warn"),
    log: vi.spyOn(console, "log"),
    info: vi.spyOn(console, "info"),
    debug: vi.spyOn(console, "debug"),
  };

  // Suppress requested methods
  for (const method of methods) {
    spies[method].mockImplementation(() => {});
  }

  return {
    ...spies,
    restore: () => {
      for (const spy of Object.values(spies)) {
        spy.mockRestore();
      }
    },
  };
}

// =============================================================================
// API Mock Factories
// =============================================================================

/**
 * Creates a mock IWorkspaceApi with sensible defaults.
 * All methods return mock functions that can be configured in tests.
 *
 * @param overrides - Optional method overrides
 * @returns Mock IWorkspaceApi with all methods mocked
 *
 * @example
 * ```typescript
 * const mockApi = createMockWorkspaceApi();
 * mockApi.getStatus.mockResolvedValue({ isDirty: true, agent: { type: "busy" } });
 * ```
 */
export function createMockWorkspaceApi(overrides?: Partial<IWorkspaceApi>): IWorkspaceApi {
  return {
    create: vi.fn().mockResolvedValue(MOCK_WORKSPACE_API_DEFAULTS.workspace),
    remove: vi.fn().mockResolvedValue(MOCK_WORKSPACE_API_DEFAULTS.removeResult),
    forceRemove: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue(MOCK_WORKSPACE_API_DEFAULTS.status),
    getOpencodePort: vi.fn().mockResolvedValue(null),
    restartOpencodeServer: vi.fn().mockResolvedValue(14001),
    setMetadata: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue(MOCK_WORKSPACE_API_DEFAULTS.metadata),
    executeCommand: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Creates a mock ICoreApi with sensible defaults.
 * All methods return mock functions that can be configured in tests.
 *
 * @param overrides - Optional overrides for workspaces or projects APIs
 * @returns Mock ICoreApi with all methods mocked
 *
 * @example
 * ```typescript
 * const mockApi = createMockCoreApi();
 * mockApi.workspaces.getStatus.mockResolvedValue({ isDirty: true, agent: { type: "busy" } });
 * ```
 */
export function createMockCoreApi(overrides?: { workspaces?: Partial<IWorkspaceApi> }): ICoreApi {
  return {
    workspaces: createMockWorkspaceApi(overrides?.workspaces),
    projects: {} as IProjectApi,
    on: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}
