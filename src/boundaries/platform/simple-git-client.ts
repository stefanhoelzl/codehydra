/**
 * SimpleGitClient implementation using the simple-git library.
 */

import {
  simpleGit,
  GitError as SimpleGitError,
  type SimpleGit,
  type SimpleGitOptions,
} from "simple-git";
import { vulnerabilityCheck } from "@simple-git/argv-parser";
import { GitError, getErrorMessage } from "../../shared/errors/service-errors";
import type { IGitClient, CloneProgressCallback } from "./git-client";
import type { BranchInfo, StatusResult, WorktreeInfo } from "./git-types";
import type { Logger } from "./logging";
import { Path } from "../../utils/path/path";

/**
 * The environment every git call runs with, and the simple-git options that let
 * it through.
 *
 * GIT_OPTIONAL_LOCKS=0 suppresses only *optional* locks — the ones git takes as a
 * side-effect optimization, e.g. `git status` grabbing index.lock to rewrite the
 * index it didn't need to. Write operations (add/commit/branch/worktree) still
 * take their *required* locks and behave normally, so this is safe to apply
 * uniformly. The win is that our status checks stop contending with the embedded
 * editor's watcher/refresh for index.lock while an agent is writing. This mirrors
 * VS Code's own git extension.
 *
 * Everything else is the environment the app was launched with, passed through
 * unchanged. simple-git 4 guards git's own variables (every `GIT_*`, plus
 * `EDITOR`, `PAGER`, `SSH_ASKPASS`, …): an ambient one is stripped and an
 * explicit one rejects the call, and some (`GIT_SSH_COMMAND`, `GIT_ASKPASS`,
 * `GIT_CONFIG_GLOBAL`, …) additionally need their `unsafe` category enabled. That
 * guards against untrusted input; this is the user's own environment, and
 * stripping it would ignore their SSH command, askpass and relocated gitconfig —
 * a clone that works in their terminal would fail here. So every key present is
 * allowed, and exactly the categories simple-git's own checker reports for this
 * environment are enabled — the argument checks stay on for every other
 * category.
 */
function gitEnvironment(): {
  env: Record<string, string>;
  allowEnvironment: readonly string[];
  unsafe: NonNullable<SimpleGitOptions["unsafe"]>;
} {
  const env: Record<string, string> = { GIT_OPTIONAL_LOCKS: "0" };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "GIT_OPTIONAL_LOCKS") env[key] = value;
  }
  const unsafe = Object.fromEntries(
    vulnerabilityCheck([], env).map((vulnerability) => [vulnerability.category, true])
  );
  return { env, allowEnvironment: Object.keys(env), unsafe };
}

/**
 * A git command that exited non-zero, with its exit code.
 *
 * Private to this boundary: callers of `IGitClient` only ever see `GitError`.
 * It exists so the methods here can branch on git's documented exit codes
 * (`git config` exits 1 for an unset key, 5 for nothing to unset) instead of
 * git's wording, which is localized.
 */
class GitExitError extends SimpleGitError {
  constructor(
    message: string,
    readonly exitCode: number
  ) {
    // simple-git's own error type: anything else it re-wraps, losing `exitCode`.
    super(undefined, message);
    this.name = "GitExitError";
  }
}

/**
 * simple-git `errors` handler: every non-zero exit rejects.
 *
 * simple-git's default treats a non-zero exit as success when stderr is empty,
 * which is exactly how `git config` reports "not set" (exit 1, 5) — the result
 * was indistinguishable from an empty value. A spawn failure (`error` already
 * set) passes through unchanged. The message is stdout + stderr, as with the
 * default handler.
 */
const rejectEveryFailedExit: NonNullable<SimpleGitOptions["errors"]> = (error, result) => {
  if (error !== undefined || result.exitCode === 0) return error;
  const output = Buffer.concat([...result.stdOut, ...result.stdErr])
    .toString("utf-8")
    .trim();
  return new GitExitError(output || `git exited with code ${result.exitCode}`, result.exitCode);
};

function exitCodeOf(error: unknown): number | undefined {
  return error instanceof GitExitError ? error.exitCode : undefined;
}

/**
 * Implementation of IGitClient using the simple-git library.
 * Wraps simple-git calls and maps errors to GitError.
 *
 * All path parameters use the Path class for normalized, cross-platform handling.
 * Internally converts to native format when calling simple-git.
 */
export class SimpleGitClient implements IGitClient {
  /** Tail of the config-write queue; see `serializeConfigWrite`. */
  private configWrites: Promise<void> = Promise.resolve();

  constructor(private readonly logger: Logger) {}

  /**
   * Create a simple-git instance for a given path.
   * Accepts Path and converts to native format for simple-git.
   */
  private getGit(basePath: Path): SimpleGit {
    const { env, ...guard } = gitEnvironment();
    const options: Partial<SimpleGitOptions> = {
      ...guard,
      baseDir: basePath.toNative(),
      binary: "git",
      maxConcurrentProcesses: 6,
      trimmed: true,
      config: process.platform === "win32" ? ["core.longpaths=true"] : [],
      errors: rejectEveryFailedExit,
    };
    // The whole environment, not just the additions: simple-git passes `env`
    // straight to child_process.spawn, which *replaces* (not merges) the child
    // environment, so a bare { GIT_OPTIONAL_LOCKS } would drop PATH/HOME.
    return simpleGit(options).env(env);
  }

  /**
   * Wrap a simple-git operation and convert errors to GitError.
   */
  private async wrapGitOperation<T>(operation: () => Promise<T>, errorMessage: string): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      const errMsg = getErrorMessage(error);
      throw new GitError(`${errorMessage}: ${errMsg}`);
    }
  }

  /**
   * Run a write to the repository's config after every write queued before it.
   *
   * `git config` rewrites `.git/config` through `.git/config.lock` and fails at
   * once, without retrying, when another write holds that lock ("could not lock
   * config file"). CodeHydra issues such writes concurrently — a lock handoff
   * retags two workspaces at the same time, and every worktree of a repository
   * shares its one config — so all of them take turns here. One queue for the
   * whole client rather than one per repository: a worktree path and its
   * repository's path name the same config, and these writes take milliseconds.
   */
  private serializeConfigWrite<T>(write: () => Promise<T>): Promise<T> {
    const result = this.configWrites.then(write);
    this.configWrites = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async isRepositoryRoot(repoPath: Path): Promise<boolean> {
    try {
      const git = this.getGit(repoPath);

      // Check if this is a bare repository first
      // Note: We can't use checkIsRepo() first because it uses --is-inside-work-tree
      // which returns false for bare repos (they have no working tree)
      let isBare = false;
      try {
        const isBareResult = await git.revparse(["--is-bare-repository"]);
        isBare = isBareResult.trim() === "true";
      } catch (error: unknown) {
        // revparse fails for non-git directories - this is expected, return false.
        // Not narrowed to git's "not a git repository": that message is localized,
        // and a non-English git would then fail every non-repo check. Git's own
        // words go in the log line, so a failure of any other kind is visible.
        this.logger.scoped({ path: repoPath.toString() }).debug("IsRepositoryRoot", {
          result: false,
          reason: "not a repo (revparse failed)",
          error: getErrorMessage(error),
        });
        return false;
      }

      if (isBare) {
        // For bare repos, check if --git-dir returns "." (meaning we're at the root)
        const gitDir = await git.revparse(["--git-dir"]);
        const isRoot = gitDir.trim() === ".";
        this.logger
          .scoped({ path: repoPath.toString() })
          .debug("IsRepositoryRoot (bare)", { gitDir: gitDir.trim(), result: isRoot });
        return isRoot;
      }

      // For non-bare repos, first verify we're inside a work tree ("false" inside .git)
      const isRepo = (await git.revparse(["--is-inside-work-tree"])).trim() === "true";
      if (!isRepo) {
        this.logger
          .scoped({ path: repoPath.toString() })
          .debug("IsRepositoryRoot", { result: false, reason: "not a repo" });
        return false;
      }

      // Get the actual repository root - git returns POSIX paths
      const root = await git.revparse(["--show-toplevel"]);
      // Wrap git output directly with Path (git returns POSIX format)
      const rootPath = new Path(root.trim());

      // Compare normalized paths
      const isRoot = rootPath.equals(repoPath);
      this.logger
        .scoped({ path: repoPath.toString() })
        .debug("IsRepositoryRoot", { root: rootPath.toString(), result: isRoot });
      return isRoot;
    } catch (error: unknown) {
      // If the path doesn't exist or is inaccessible, throw GitError
      const errMsg = getErrorMessage(error);
      throw new GitError(`Failed to check repository root: ${errMsg}`);
    }
  }

  async listWorktrees(repoPath: Path): Promise<readonly WorktreeInfo[]> {
    const worktrees = await this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);

      // Get raw worktree list output
      const result = await git.raw(["worktree", "list", "--porcelain"]);

      const worktreesResult: WorktreeInfo[] = [];
      const entries = result.split("\n\n").filter((entry) => entry.trim());

      for (const entry of entries) {
        const lines = entry.split("\n");
        let worktreePath: Path | null = null;
        let branch: string | null = null;
        let prunable = false;

        for (const line of lines) {
          if (line.startsWith("worktree ")) {
            // Git on all platforms outputs POSIX paths (C:/Users/...)
            // Wrap directly with Path - no conversion needed!
            // This is the KEY FIX: don't use path.normalize() which
            // would convert to native format (backslashes on Windows)
            worktreePath = new Path(line.substring("worktree ".length));
          } else if (line.startsWith("branch ")) {
            // Branch format is "refs/heads/branch-name"
            const ref = line.substring("branch ".length);
            branch = ref.replace("refs/heads/", "");
          } else if (line === "detached") {
            branch = null;
          } else if (line === "bare") {
            // Skip bare repository entries
            continue;
          } else if (line.startsWith("prunable")) {
            prunable = true;
          }
        }

        // First worktree is the main one
        const isMain = worktreesResult.length === 0;

        if (worktreePath) {
          const name = worktreePath.basename;
          worktreesResult.push({
            name,
            path: worktreePath,
            branch,
            isMain,
            prunable,
          });
        }
      }

      return worktreesResult;
    }, "Failed to list worktrees");

    this.logger
      .scoped({ path: repoPath.toString() })
      .debug("ListWorktrees", { count: worktrees.length });
    return worktrees;
  }

  async addWorktree(repoPath: Path, worktreePath: Path, branch: string): Promise<void> {
    await this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      // Pass native path to git command
      await git.raw(["worktree", "add", worktreePath.toNative(), branch]);
    }, `Failed to add worktree at ${worktreePath.toString()}`);
    this.logger.scoped({ path: worktreePath.toString() }).debug("AddWorktree", { branch });
  }

  async addDetachedWorktree(repoPath: Path, worktreePath: Path, commit: string): Promise<void> {
    await this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      await git.raw(["worktree", "add", "--detach", worktreePath.toNative(), commit]);
    }, `Failed to add worktree at ${worktreePath.toString()}`);
    this.logger.scoped({ path: worktreePath.toString() }).debug("AddDetachedWorktree", { commit });
  }

  async removeWorktree(repoPath: Path, worktreePath: Path): Promise<void> {
    await this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      // Pass native path to git command
      await git.raw(["worktree", "remove", worktreePath.toNative(), "--force"]);
    }, `Failed to remove worktree at ${worktreePath.toString()}`);
    this.logger.scoped({ path: worktreePath.toString() }).debug("RemoveWorktree");
  }

  async pruneWorktrees(repoPath: Path): Promise<void> {
    return this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      await git.raw(["worktree", "prune"]);
    }, "Failed to prune worktrees");
  }

  async repairWorktrees(repoPath: Path, worktreePaths: readonly Path[]): Promise<void> {
    if (worktreePaths.length === 0) return;
    await this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      await git.raw(["worktree", "repair", ...worktreePaths.map((p) => p.toNative())]);
    }, `Failed to repair worktrees of ${repoPath.toString()}`);
    this.logger.debug("RepairWorktrees", {
      repo: repoPath.toString(),
      count: worktreePaths.length,
    });
  }

  async listBranches(repoPath: Path): Promise<readonly BranchInfo[]> {
    const branches = await this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      const summary = await git.branch(["-a"]);

      const branchesResult: BranchInfo[] = [];

      for (const branchName of Object.keys(summary.branches)) {
        const isRemote = branchName.startsWith("remotes/");

        // Clean up the name for remote branches
        let name = branchName;
        if (isRemote) {
          // Remove "remotes/" prefix and skip HEAD references
          name = branchName.replace("remotes/", "");
          if (name.endsWith("/HEAD")) {
            continue;
          }
        }

        branchesResult.push({
          name,
          isRemote,
        });
      }

      return branchesResult;
    }, "Failed to list branches");

    const localCount = branches.filter((b) => !b.isRemote).length;
    const remoteCount = branches.filter((b) => b.isRemote).length;
    this.logger
      .scoped({ path: repoPath.toString() })
      .debug("ListBranches", { local: localCount, remote: remoteCount });
    return branches;
  }

  async createBranch(
    repoPath: Path,
    name: string,
    startPoint: string,
    options?: { track?: boolean }
  ): Promise<void> {
    // A config write: --track records the upstream as branch.<name>.remote/merge.
    return this.serializeConfigWrite(() =>
      this.wrapGitOperation(async () => {
        const git = this.getGit(repoPath);
        const args = options?.track ? [name, "--track", startPoint] : [name, startPoint];
        await git.branch(args);
      }, `Failed to create branch ${name}`)
    );
  }

  async deleteBranch(repoPath: Path, name: string): Promise<void> {
    // A config write: deleting a branch removes its branch.<name> section.
    await this.serializeConfigWrite(() =>
      this.wrapGitOperation(async () => {
        const git = this.getGit(repoPath);
        // Use -D to force delete (handles unmerged branches)
        await git.branch(["-D", name]);
      }, `Failed to delete branch ${name}`)
    );
    this.logger.scoped({ path: repoPath.toString() }).debug("DeleteBranch", { branch: name });
  }

  async getWorktreeGitDir(worktreePath: Path): Promise<Path> {
    return this.wrapGitOperation(async () => {
      const git = this.getGit(worktreePath);
      const gitDir = await git.revparse(["--absolute-git-dir"]);
      return new Path(gitDir.trim());
    }, "Failed to resolve worktree git directory");
  }

  async getCurrentBranch(repoPath: Path): Promise<string | null> {
    return this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      const result = await git.revparse(["--abbrev-ref", "HEAD"]);

      // "HEAD" is returned when in detached HEAD state
      if (result === "HEAD") {
        return null;
      }

      return result;
    }, "Failed to get current branch");
  }

  async getStatus(repoPath: Path): Promise<StatusResult> {
    const status = await this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      const gitStatus = await git.status();

      // Modified files that are not staged
      const modifiedCount = gitStatus.modified.length + gitStatus.deleted.length;
      // Staged files (created/added files that are staged)
      const stagedCount = gitStatus.staged.length;
      // Untracked files (not_added means not tracked by git)
      const untrackedCount = gitStatus.not_added.length;

      const isDirty = modifiedCount > 0 || stagedCount > 0 || untrackedCount > 0;

      return {
        isDirty,
        modifiedCount,
        stagedCount,
        untrackedCount,
      };
    }, "Failed to get status");

    this.logger.scoped({ path: repoPath.toString() }).debug("GetStatus", { dirty: status.isDirty });
    return status;
  }

  async fetch(repoPath: Path, remote: string): Promise<void> {
    await this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      // Use array format to ensure remote is treated as remote name, not refspec
      // Include --prune to remove stale remote-tracking branches
      await git.fetch([remote, "--prune"]);
    }, `Failed to fetch from ${remote}`);
    await this.updateRemoteHead(repoPath, remote);
    this.logger.scoped({ path: repoPath.toString() }).debug("Fetch", { remote });
  }

  /**
   * Create/update the refs/remotes/<remote>/HEAD symref from the remote's actual HEAD.
   * Backports git >= 2.47 followRemoteHEAD behavior; failures are tolerated because the
   * symref is an optimization for default-branch detection, never a correctness requirement.
   */
  private async updateRemoteHead(repoPath: Path, remote: string): Promise<void> {
    try {
      const git = this.getGit(repoPath);
      await git.raw(["remote", "set-head", remote, "--auto"]);
    } catch (error: unknown) {
      this.logger
        .scoped({ path: repoPath.toString() })
        .warn("Failed to update remote HEAD", { remote, error: getErrorMessage(error) });
    }
  }

  async getDefaultBranch(repoPath: Path, remote?: string): Promise<string | null> {
    try {
      const git = this.getGit(repoPath);
      const ref = remote ? `refs/remotes/${remote}/HEAD` : "HEAD";
      // symbolic-ref (unlike rev-parse) resolves dangling symrefs, which is the normal
      // HEAD state of bare clones after their local branches are deleted
      const target = (await git.raw(["symbolic-ref", ref])).trim();
      const prefix = remote ? `refs/remotes/${remote}/` : "refs/heads/";
      return target.startsWith(prefix) ? target.substring(prefix.length) : null;
    } catch {
      // Missing symref, detached HEAD, or not a repository — no answer
      return null;
    }
  }

  async listRemotes(repoPath: Path): Promise<readonly string[]> {
    return this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      const remotes = await git.getRemotes();
      return remotes.map((r) => r.name);
    }, "Failed to list remotes");
  }

  async getGitConfig(
    repoPath: Path,
    options: { key: string } | { regex: string }
  ): Promise<ReadonlyMap<string, string>> {
    const result = new Map<string, string>();
    const args =
      "key" in options
        ? ["config", "--local", "--get", options.key]
        : ["config", "--local", "--get-regexp", options.regex];

    try {
      const git = this.getGit(repoPath);
      const output = await git.raw(args);

      if ("key" in options) {
        // --get returns a single value; empty output means no value
        const value = output.trim();
        if (value) {
          result.set(options.key, value);
        }
        return result;
      }

      // --get-regexp: each line is "key value" (value is everything after the first space)
      for (const line of output.split("\n")) {
        if (!line.trim()) continue;
        const spaceIndex = line.indexOf(" ");
        if (spaceIndex === -1) continue;
        result.set(line.substring(0, spaceIndex), line.substring(spaceIndex + 1));
      }
      return result;
    } catch (error: unknown) {
      // Exit code 1 means no match / key unset - return empty map. `--local`
      // makes a path outside any repository fail (exit 128) instead of falling
      // back to the global config.
      if (exitCodeOf(error) === 1) {
        return result;
      }
      const errMsg = getErrorMessage(error);
      throw new GitError(`Failed to get git config: ${errMsg}`);
    }
  }

  async setBranchConfig(repoPath: Path, branch: string, key: string, value: string): Promise<void> {
    return this.serializeConfigWrite(() =>
      this.wrapGitOperation(async () => {
        const git = this.getGit(repoPath);
        const configKey = `branch.${branch}.${key}`;
        await git.raw(["config", configKey, value]);
      }, `Failed to set branch config branch.${branch}.${key}`)
    );
  }

  async unsetBranchConfig(repoPath: Path, branch: string, key: string): Promise<void> {
    return this.serializeConfigWrite(async () => {
      try {
        const git = this.getGit(repoPath);
        const configKey = `branch.${branch}.${key}`;
        await git.raw(["config", "--local", "--unset", configKey]);
      } catch (error: unknown) {
        // Exit code 5 means key doesn't exist - that's OK for unset. Outside a
        // repository `--local` exits 128, which throws below.
        if (exitCodeOf(error) === 5) {
          return;
        }
        const errMsg = getErrorMessage(error);
        throw new GitError(`Failed to unset branch config: ${errMsg}`);
      }
    });
  }

  async removeConfigSection(repoPath: Path, section: string): Promise<void> {
    return this.serializeConfigWrite(() =>
      this.wrapGitOperation(async () => {
        const git = this.getGit(repoPath);
        await git.raw(["config", "--local", "--remove-section", section]);
      }, `Failed to remove config section ${section}`)
    );
  }

  async resolveCommit(repoPath: Path, rev: string): Promise<string | null> {
    try {
      const git = this.getGit(repoPath);
      // `--end-of-options` keeps a revision that starts with "-" from reading as a flag.
      const hash = (
        await git.raw(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`])
      ).trim();
      return hash === "" ? null : hash;
    } catch {
      // --verify --quiet exits 1 for a revision that names nothing: no answer.
      return null;
    }
  }

  async clone(url: string, targetPath: Path, onProgress?: CloneProgressCallback): Promise<void> {
    return this.wrapGitOperation(async () => {
      // Use simple-git's clone with bare option
      // Create git instance at the parent directory to run clone command
      // allowUnsafePack is required because simple-git 3.32+ false-positives
      // on Windows paths (drive letter matches its -u regex check)
      const { env, allowEnvironment, unsafe } = gitEnvironment();
      const options: Partial<SimpleGitOptions> = {
        allowEnvironment,
        unsafe: { ...unsafe, allowUnsafePack: true },
        errors: rejectEveryFailedExit,
      };
      if (onProgress) {
        options.progress = (data) => {
          onProgress({ stage: data.stage, progress: data.progress });
        };
      }
      const git = simpleGit(options).env(env);
      await git.clone(url, targetPath.toNative(), ["--bare"]);

      // Set up remote tracking for the bare clone
      // By default, bare clones don't have remote-tracking branches (refs/remotes/origin/*)
      // We configure fetch to create them so branches show up under "Remote Branches" in UI
      const bareGit = this.getGit(targetPath);
      await bareGit.addConfig("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      await bareGit.fetch(["origin"]);

      // Record the remote's default branch as refs/remotes/origin/HEAD
      // (bare clones don't get this symref; defaultBase() reads it)
      await this.updateRemoteHead(targetPath, "origin");

      // Delete local branches - only keep remote-tracking branches
      // This prevents confusion: branches show under "Remote Branches" header in UI
      // Without this, git clone --bare creates local branches (refs/heads/*) not remote-tracking ones
      const branches = await bareGit.branch(["-l"]);
      for (const branchName of Object.keys(branches.branches)) {
        await bareGit.branch(["-D", branchName]);
      }
    }, `Failed to clone repository from ${url}`);
  }

  async init(targetPath: Path, options?: { initialCommit?: string }): Promise<void> {
    await this.wrapGitOperation(async () => {
      const git = this.getGit(targetPath);
      await git.init();
      if (options?.initialCommit) {
        await git.commit(options.initialCommit, { "--allow-empty": null });
      }
    }, `Failed to initialize repository at ${targetPath.toString()}`);
    this.logger.scoped({ path: targetPath.toString() }).debug("Init");
  }

  async countUnmergedCommits(repoPath: Path, branch: string, base: string): Promise<number> {
    return this.wrapGitOperation(async () => {
      const git = this.getGit(repoPath);
      const result = await git.raw([
        "rev-list",
        "--count",
        "--cherry-pick",
        "--right-only",
        `${base}...${branch}`,
      ]);
      return parseInt(result.trim(), 10);
    }, `Failed to count unmerged commits for ${branch} against ${base}`);
  }
}
