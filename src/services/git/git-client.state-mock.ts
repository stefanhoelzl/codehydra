/**
 * Behavioral mock for IGitClient with in-memory state.
 *
 * Provides a stateful mock that simulates real git behavior:
 * - In-memory repository, branch, and worktree storage
 * - Proper error handling (GitError for invalid operations)
 * - Custom matchers for behavioral assertions
 *
 * @example
 * const mock = createMockGitClient({
 *   repositories: {
 *     "/project": {
 *       branches: ["main", "feature-x"],
 *       remoteBranches: ["origin/main"],
 *       remotes: ["origin"],
 *       worktrees: [{ name: "feature-x", path: "/workspaces/feature-x", branch: "feature-x", isDirty: false }],
 *       branchConfigs: { "feature-x": { "codehydra.base": "main" } },
 *       mainIsDirty: false,
 *       currentBranch: "main",
 *     },
 *   },
 * });
 *
 * await mock.createBranch(new Path("/project"), "feature-y", "main");
 * expect(mock).toHaveBranch("/project", "feature-y");
 */

import { expect } from "vitest";
import type { IGitClient } from "./git-client";
import type { BranchInfo, StatusResult, WorktreeInfo } from "./types";
import { GitError } from "../errors";
import { Path } from "../platform/path";
import type {
  MockState,
  MockWithState,
  Snapshot,
  MatcherImplementationsFor,
} from "../../test/state-mock";

// =============================================================================
// Internal State Types
// =============================================================================

/**
 * Internal worktree state.
 */
interface WorktreeState {
  readonly name: string;
  readonly path: string;
  readonly branch: string | null;
  readonly isDirty: boolean;
}

/**
 * Internal repository state.
 */
interface RepositoryState {
  /** Local branch names */
  branches: Set<string>;
  /** Remote branch names (e.g., "origin/main") */
  remoteBranches: Set<string>;
  /** Remote names (e.g., "origin") */
  remotes: Set<string>;
  /** Worktrees by normalized path */
  worktrees: Map<string, WorktreeState>;
  /** Branch configurations: branch -> key -> value */
  branchConfigs: Map<string, Map<string, string>>;
  /** Main worktree dirty state */
  mainIsDirty: boolean;
  /** Main worktree's current branch */
  currentBranch: string | null;
}

// =============================================================================
// Factory Options
// =============================================================================

/**
 * Worktree initialization options.
 */
export interface WorktreeInit {
  /** Worktree name (derived from directory name) */
  readonly name: string;
  /** Absolute path to the worktree directory */
  readonly path: string;
  /** Branch checked out in worktree, null for detached HEAD */
  readonly branch: string | null;
  /** Whether the worktree has uncommitted changes. Defaults to `false`. */
  readonly isDirty?: boolean;
}

/**
 * Repository initialization options.
 */
export interface RepositoryInit {
  /** Local branch names */
  readonly branches?: readonly string[];
  /** Remote branch names (e.g., "origin/main") */
  readonly remoteBranches?: readonly string[];
  /** Remote names (e.g., "origin") */
  readonly remotes?: readonly string[];
  /** Worktrees in this repository (non-main) */
  readonly worktrees?: readonly WorktreeInit[];
  /** Branch configurations: branch -> { key: value } */
  readonly branchConfigs?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Whether the main worktree has uncommitted changes */
  readonly mainIsDirty?: boolean;
  /** Main worktree's current branch (defaults to first branch or "main") */
  readonly currentBranch?: string | null;
}

/**
 * Options for creating a mock git client.
 */
export interface MockGitClientOptions {
  /** Repositories by path */
  readonly repositories?: Readonly<Record<string, RepositoryInit>>;
}

// =============================================================================
// State Interface
// =============================================================================

/**
 * State interface for the git client mock.
 * Provides read access to repositories and test helper methods.
 */
export interface GitClientMockState extends MockState {
  /**
   * Read-only access to all repositories.
   * Keys are normalized path strings.
   */
  readonly repositories: ReadonlyMap<string, Readonly<RepositoryState>>;

  /**
   * Capture current state as snapshot for later comparison.
   */
  snapshot(): Snapshot;

  /**
   * Human-readable representation of git state.
   * Sorted by repository path for deterministic output.
   */
  toString(): string;
}

/**
 * IGitClient with behavioral mock state access via `$` property.
 */
export type MockGitClient = IGitClient & MockWithState<GitClientMockState>;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Normalize a path for use as a map key.
 */
function normalizePath(path: Path | string): string {
  if (path instanceof Path) {
    return path.toString();
  }
  return new Path(path).toString();
}

// =============================================================================
// State Implementation
// =============================================================================

class GitClientMockStateImpl implements GitClientMockState {
  private readonly _repositories: Map<string, RepositoryState>;

  constructor(initialRepos?: Map<string, RepositoryState>) {
    this._repositories = initialRepos ?? new Map();
  }

  get repositories(): ReadonlyMap<string, Readonly<RepositoryState>> {
    return this._repositories;
  }

  getRepo(path: string): RepositoryState | undefined {
    return this._repositories.get(path);
  }

  snapshot(): Snapshot {
    return { __brand: "Snapshot", value: this.toString() } as Snapshot;
  }

  toString(): string {
    const sorted = [...this._repositories.entries()].sort(([a], [b]) => a.localeCompare(b));
    const lines: string[] = [];

    for (const [repoPath, repo] of sorted) {
      lines.push(`Repository: ${repoPath}`);
      lines.push(`  currentBranch: ${repo.currentBranch ?? "(detached)"}`);
      lines.push(`  mainIsDirty: ${repo.mainIsDirty}`);
      lines.push(`  branches: [${[...repo.branches].sort().join(", ")}]`);
      lines.push(`  remoteBranches: [${[...repo.remoteBranches].sort().join(", ")}]`);
      lines.push(`  remotes: [${[...repo.remotes].sort().join(", ")}]`);

      const worktreePaths = [...repo.worktrees.keys()].sort();
      for (const wtPath of worktreePaths) {
        const wt = repo.worktrees.get(wtPath)!;
        lines.push(
          `  worktree: ${wtPath} (name=${wt.name}, branch=${wt.branch ?? "(detached)"}, isDirty=${wt.isDirty})`
        );
      }

      const branchNames = [...repo.branchConfigs.keys()].sort();
      for (const branch of branchNames) {
        const configs = repo.branchConfigs.get(branch)!;
        const configEntries = [...configs.entries()].sort(([a], [b]) => a.localeCompare(b));
        for (const [key, value] of configEntries) {
          lines.push(`  config[${branch}].${key}: ${value}`);
        }
      }
    }

    return lines.join("\n");
  }
}

// =============================================================================
// Factory Implementation
// =============================================================================

/**
 * Create a behavioral mock for IGitClient.
 *
 * @example Basic setup
 * const mock = createMockGitClient({
 *   repositories: {
 *     "/project": {
 *       branches: ["main", "feature-x"],
 *       remoteBranches: ["origin/main"],
 *       remotes: ["origin"],
 *       worktrees: [{ name: "feature-x", path: "/workspaces/feature-x", branch: "feature-x" }],
 *       branchConfigs: { "feature-x": { "codehydra.base": "main" } },
 *       currentBranch: "main",
 *     },
 *   },
 * });
 */
export function createMockGitClient(options?: MockGitClientOptions): MockGitClient {
  // Initialize repositories
  const repos = new Map<string, RepositoryState>();

  if (options?.repositories) {
    for (const [path, init] of Object.entries(options.repositories)) {
      const normalizedPath = normalizePath(path);

      // Build branch configs map
      const branchConfigs = new Map<string, Map<string, string>>();
      if (init.branchConfigs) {
        for (const [branch, configs] of Object.entries(init.branchConfigs)) {
          const configMap = new Map<string, string>();
          for (const [key, value] of Object.entries(configs)) {
            configMap.set(key, value);
          }
          branchConfigs.set(branch, configMap);
        }
      }

      // Build worktrees map
      const worktrees = new Map<string, WorktreeState>();
      if (init.worktrees) {
        for (const wt of init.worktrees) {
          const wtPath = normalizePath(wt.path);
          worktrees.set(wtPath, {
            name: wt.name,
            path: wtPath,
            branch: wt.branch,
            isDirty: wt.isDirty ?? false,
          });
        }
      }

      repos.set(normalizedPath, {
        branches: new Set(init.branches ?? []),
        remoteBranches: new Set(init.remoteBranches ?? []),
        remotes: new Set(init.remotes ?? []),
        worktrees,
        branchConfigs,
        mainIsDirty: init.mainIsDirty ?? false,
        currentBranch: init.currentBranch ?? init.branches?.[0] ?? null,
      });
    }
  }

  const state = new GitClientMockStateImpl(repos);

  // Helper to get repository or throw GitError
  const getRepoOrThrow = (path: Path | string): RepositoryState => {
    const normalizedPath = normalizePath(path);
    const repo = state.getRepo(normalizedPath);
    if (!repo) {
      throw new GitError(`Not a git repository: ${normalizedPath}`);
    }
    return repo;
  };

  // Helper to find repository containing a worktree path
  const findRepoForWorktree = (worktreePath: string): [string, RepositoryState] | undefined => {
    for (const [repoPath, repo] of state.repositories) {
      // Check if path is the main repo
      if (worktreePath === repoPath) {
        return [repoPath, repo as RepositoryState];
      }
      // Check if path is a worktree
      if (repo.worktrees.has(worktreePath)) {
        return [repoPath, repo as RepositoryState];
      }
    }
    return undefined;
  };

  const client: IGitClient = {
    async isRepositoryRoot(path: Path): Promise<boolean> {
      const normalizedPath = normalizePath(path);
      return state.repositories.has(normalizedPath);
    },

    async listWorktrees(repoPath: Path): Promise<readonly WorktreeInfo[]> {
      const repo = getRepoOrThrow(repoPath);
      const normalizedRepoPath = normalizePath(repoPath);

      const result: WorktreeInfo[] = [];

      // Main worktree first
      result.push({
        name: new Path(normalizedRepoPath).basename,
        path: new Path(normalizedRepoPath),
        branch: repo.currentBranch,
        isMain: true,
      });

      // Non-main worktrees
      const sortedWorktrees = [...repo.worktrees.entries()].sort(([a], [b]) => a.localeCompare(b));
      for (const [wtPath, wt] of sortedWorktrees) {
        result.push({
          name: wt.name,
          path: new Path(wtPath),
          branch: wt.branch,
          isMain: false,
        });
      }

      return result;
    },

    async addWorktree(repoPath: Path, worktreePath: Path, branch: string): Promise<void> {
      const repo = getRepoOrThrow(repoPath);
      const normalizedRepoPath = normalizePath(repoPath);
      const normalizedWorktreePath = normalizePath(worktreePath);

      // Check if branch exists
      if (!repo.branches.has(branch)) {
        throw new GitError(`Branch '${branch}' not found`);
      }

      // Check if branch is already checked out
      // Check main worktree
      if (repo.currentBranch === branch) {
        throw new GitError(`Branch '${branch}' is already checked out at ${normalizedRepoPath}`);
      }
      // Check other worktrees
      for (const [wtPath, wt] of repo.worktrees) {
        if (wt.branch === branch) {
          throw new GitError(`Branch '${branch}' is already checked out at ${wtPath}`);
        }
      }

      // Add the worktree
      repo.worktrees.set(normalizedWorktreePath, {
        name: new Path(normalizedWorktreePath).basename,
        path: normalizedWorktreePath,
        branch,
        isDirty: false,
      });
    },

    async removeWorktree(repoPath: Path, worktreePath: Path): Promise<void> {
      const repo = getRepoOrThrow(repoPath);
      const normalizedWorktreePath = normalizePath(worktreePath);

      if (!repo.worktrees.has(normalizedWorktreePath)) {
        throw new GitError(`Worktree not found: ${normalizedWorktreePath}`);
      }

      repo.worktrees.delete(normalizedWorktreePath);
    },

    async pruneWorktrees(_repoPath: Path): Promise<void> {
      // No-op in mock - nothing to prune
    },

    async listBranches(repoPath: Path): Promise<readonly BranchInfo[]> {
      const repo = getRepoOrThrow(repoPath);

      const result: BranchInfo[] = [];

      // Local branches
      for (const branch of [...repo.branches].sort()) {
        result.push({ name: branch, isRemote: false });
      }

      // Remote branches
      for (const branch of [...repo.remoteBranches].sort()) {
        result.push({ name: branch, isRemote: true });
      }

      return result;
    },

    async createBranch(repoPath: Path, name: string, startPoint: string): Promise<void> {
      const repo = getRepoOrThrow(repoPath);

      // Check if branch already exists
      if (repo.branches.has(name)) {
        throw new GitError(`Branch '${name}' already exists`);
      }

      // Check if start point exists (must be in branches or remoteBranches)
      if (!repo.branches.has(startPoint) && !repo.remoteBranches.has(startPoint)) {
        throw new GitError(`Start point '${startPoint}' not found`);
      }

      repo.branches.add(name);
    },

    async deleteBranch(repoPath: Path, name: string): Promise<void> {
      const repo = getRepoOrThrow(repoPath);
      const normalizedRepoPath = normalizePath(repoPath);

      // Check if branch exists
      if (!repo.branches.has(name)) {
        throw new GitError(`Branch '${name}' not found`);
      }

      // Check if branch is checked out in main worktree
      if (repo.currentBranch === name) {
        throw new GitError(`Cannot delete branch '${name}': checked out at ${normalizedRepoPath}`);
      }

      // Check if branch is checked out in any worktree
      for (const [wtPath, wt] of repo.worktrees) {
        if (wt.branch === name) {
          throw new GitError(`Cannot delete branch '${name}': checked out at ${wtPath}`);
        }
      }

      repo.branches.delete(name);
    },

    async getCurrentBranch(path: Path): Promise<string | null> {
      const normalizedPath = normalizePath(path);

      // Check if it's a main repo
      const repo = state.getRepo(normalizedPath);
      if (repo) {
        return repo.currentBranch;
      }

      // Check if it's a worktree
      const found = findRepoForWorktree(normalizedPath);
      if (found) {
        const [, foundRepo] = found;
        const wt = foundRepo.worktrees.get(normalizedPath);
        if (wt) {
          return wt.branch;
        }
      }

      throw new GitError(`Not a git repository or worktree: ${normalizedPath}`);
    },

    async getStatus(path: Path): Promise<StatusResult> {
      const normalizedPath = normalizePath(path);

      // Check if it's a main repo
      const repo = state.getRepo(normalizedPath);
      if (repo) {
        return {
          isDirty: repo.mainIsDirty,
          modifiedCount: 0,
          stagedCount: 0,
          untrackedCount: 0,
        };
      }

      // Check if it's a worktree
      const found = findRepoForWorktree(normalizedPath);
      if (found) {
        const [, foundRepo] = found;
        const wt = foundRepo.worktrees.get(normalizedPath);
        if (wt) {
          return {
            isDirty: wt.isDirty,
            modifiedCount: 0,
            stagedCount: 0,
            untrackedCount: 0,
          };
        }
      }

      throw new GitError(`Not a git repository or worktree: ${normalizedPath}`);
    },

    async fetch(repoPath: Path, remote?: string): Promise<void> {
      const repo = getRepoOrThrow(repoPath);

      // If remote specified, check it exists
      if (remote !== undefined && !repo.remotes.has(remote)) {
        throw new GitError(`Remote '${remote}' not found`);
      }

      // No-op on success - mock doesn't actually fetch
    },

    async listRemotes(repoPath: Path): Promise<readonly string[]> {
      const repo = getRepoOrThrow(repoPath);
      return [...repo.remotes].sort();
    },

    async getBranchConfig(repoPath: Path, branch: string, key: string): Promise<string | null> {
      getRepoOrThrow(repoPath); // Validate repo exists
      const repo = state.getRepo(normalizePath(repoPath))!;

      const branchConfig = repo.branchConfigs.get(branch);
      if (!branchConfig) {
        return null;
      }

      return branchConfig.get(key) ?? null;
    },

    async setBranchConfig(
      repoPath: Path,
      branch: string,
      key: string,
      value: string
    ): Promise<void> {
      getRepoOrThrow(repoPath); // Validate repo exists
      const repo = state.getRepo(normalizePath(repoPath))!;

      let branchConfig = repo.branchConfigs.get(branch);
      if (!branchConfig) {
        branchConfig = new Map();
        repo.branchConfigs.set(branch, branchConfig);
      }

      branchConfig.set(key, value);
    },

    async getBranchConfigsByPrefix(
      repoPath: Path,
      branch: string,
      prefix: string
    ): Promise<Readonly<Record<string, string>>> {
      getRepoOrThrow(repoPath); // Validate repo exists
      const repo = state.getRepo(normalizePath(repoPath))!;

      const branchConfig = repo.branchConfigs.get(branch);
      if (!branchConfig) {
        return {};
      }

      const result: Record<string, string> = {};
      const prefixWithDot = prefix + ".";

      for (const [key, value] of branchConfig) {
        if (key.startsWith(prefixWithDot)) {
          const strippedKey = key.substring(prefixWithDot.length);
          result[strippedKey] = value;
        }
      }

      return result;
    },

    async unsetBranchConfig(repoPath: Path, branch: string, key: string): Promise<void> {
      getRepoOrThrow(repoPath); // Validate repo exists
      const repo = state.getRepo(normalizePath(repoPath))!;

      const branchConfig = repo.branchConfigs.get(branch);
      if (branchConfig) {
        branchConfig.delete(key);
        // Clean up empty config maps
        if (branchConfig.size === 0) {
          repo.branchConfigs.delete(branch);
        }
      }
      // No-op if key doesn't exist (per interface contract)
    },
  };

  return Object.assign(client, { $: state });
}

// =============================================================================
// Custom Matchers
// =============================================================================

/**
 * Custom matchers for git client mock assertions.
 */
interface GitClientMatchers {
  /**
   * Assert that a local branch exists in the repository.
   *
   * @param repoPath - Absolute path to repository
   * @param branch - Branch name to check
   */
  toHaveBranch(repoPath: string | Path, branch: string): void;

  /**
   * Assert that a worktree exists in the repository.
   *
   * @param repoPath - Absolute path to repository
   * @param worktreePath - Absolute path to worktree
   */
  toHaveWorktree(repoPath: string | Path, worktreePath: string | Path): void;

  /**
   * Assert that a branch configuration is set.
   *
   * @param repoPath - Absolute path to repository
   * @param branch - Branch name
   * @param key - Configuration key
   * @param value - Optional expected value (if omitted, just checks key exists)
   */
  toHaveBranchConfig(repoPath: string | Path, branch: string, key: string, value?: string): void;
}

declare module "vitest" {
  interface Assertion<T> extends GitClientMatchers {}
}

export const gitClientMatchers: MatcherImplementationsFor<MockGitClient, GitClientMatchers> = {
  toHaveBranch(received, repoPath, branch) {
    const normalizedRepoPath = normalizePath(repoPath);
    const repo = received.$.repositories.get(normalizedRepoPath);

    if (!repo) {
      return {
        pass: false,
        message: () => `Expected repository at ${normalizedRepoPath} but it does not exist`,
      };
    }

    if (!repo.branches.has(branch)) {
      const branches = [...repo.branches].sort().join(", ");
      return {
        pass: false,
        message: () =>
          `Expected branch '${branch}' to exist in ${normalizedRepoPath}\nExisting branches: [${branches}]`,
      };
    }

    return {
      pass: true,
      message: () => `Expected branch '${branch}' not to exist in ${normalizedRepoPath}`,
    };
  },

  toHaveWorktree(received, repoPath, worktreePath) {
    const normalizedRepoPath = normalizePath(repoPath);
    const normalizedWorktreePath = normalizePath(worktreePath);
    const repo = received.$.repositories.get(normalizedRepoPath);

    if (!repo) {
      return {
        pass: false,
        message: () => `Expected repository at ${normalizedRepoPath} but it does not exist`,
      };
    }

    if (!repo.worktrees.has(normalizedWorktreePath)) {
      const worktrees = [...repo.worktrees.keys()].sort().join(", ");
      return {
        pass: false,
        message: () =>
          `Expected worktree at ${normalizedWorktreePath} in ${normalizedRepoPath}\nExisting worktrees: [${worktrees}]`,
      };
    }

    return {
      pass: true,
      message: () =>
        `Expected worktree at ${normalizedWorktreePath} not to exist in ${normalizedRepoPath}`,
    };
  },

  toHaveBranchConfig(received, repoPath, branch, key, value?) {
    const normalizedRepoPath = normalizePath(repoPath);
    const repo = received.$.repositories.get(normalizedRepoPath);

    if (!repo) {
      return {
        pass: false,
        message: () => `Expected repository at ${normalizedRepoPath} but it does not exist`,
      };
    }

    const branchConfig = repo.branchConfigs.get(branch);
    if (!branchConfig) {
      return {
        pass: false,
        message: () =>
          `Expected branch '${branch}' to have config '${key}' but branch has no config`,
      };
    }

    const actualValue = branchConfig.get(key);
    if (actualValue === undefined) {
      const keys = [...branchConfig.keys()].sort().join(", ");
      return {
        pass: false,
        message: () =>
          `Expected branch '${branch}' to have config '${key}'\nExisting keys: [${keys}]`,
      };
    }

    if (value !== undefined && actualValue !== value) {
      return {
        pass: false,
        message: () =>
          `Expected branch '${branch}' config '${key}' to be '${value}' but got '${actualValue}'`,
      };
    }

    return {
      pass: true,
      message: () =>
        value !== undefined
          ? `Expected branch '${branch}' config '${key}' not to be '${value}'`
          : `Expected branch '${branch}' not to have config '${key}'`,
    };
  },
};

// Register matchers with expect
expect.extend(gitClientMatchers);
