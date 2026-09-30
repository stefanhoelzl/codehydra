/**
 * GitWorktreeProvider - Global singleton managing git worktree operations across all projects.
 *
 * Unlike the per-project pattern, this provider manages multiple projects through internal
 * registries. Methods that previously used a bound projectRoot now accept it as a parameter.
 * Metadata methods resolve projectRoot from the workspace registry automatically.
 *
 * All consumers call methods on this provider directly, passing projectRoot per call.
 */

import type { IGitClient } from "./git-client";
import type {
  BaseInfo,
  CleanupResult,
  RemovalResult,
  UnmanagedWorktree,
  UpdateBasesResult,
  Workspace,
} from "./git-types";
import {
  WorkspaceError,
  FileSystemError,
  getErrorMessage,
} from "../../shared/errors/service-errors";
import { sanitizeWorkspaceName, unsanitizeWorkspaceName } from "./paths";
import { isValidMetadataKey } from "../../shared/api/types";
import type { FileSystemBoundary } from "./filesystem";
import type { Logger } from "./logging";
import { WorkspaceMetadataStore, type Metadata } from "./workspace-metadata-store";
import { Path } from "../../utils/path/path";

/**
 * Internal state for a registered project.
 */
interface ProjectRegistration {
  readonly workspacesDir: Path;
  /** Workspaces directories from before a workspaces-root migration; still CodeHydra's own. */
  readonly previousWorkspacesDirs: readonly Path[];
  cleanupInProgress: boolean;
}

/** Whether a worktree lies in a directory CodeHydra created it in, now or before a migration. */
function isOwnWorktree(
  registration: Pick<ProjectRegistration, "workspacesDir" | "previousWorkspacesDirs">,
  worktreePath: Path
): boolean {
  return (
    worktreePath.isChildOf(registration.workspacesDir) ||
    registration.previousWorkspacesDirs.some((dir) => worktreePath.isChildOf(dir))
  );
}

/**
 * A worktree's metadata file and what it holds: null metadata when it has no file
 * yet, null file when its git directory could not be resolved.
 */
interface LoadedMetadata {
  readonly file: Path | null;
  readonly metadata: Metadata | null;
}

/**
 * Parse flat `git config` entries into per-branch metadata records.
 *
 * Each input key is a full config key (e.g. `branch.<branch>.<prefix>.<subkey>`);
 * only keys matching `branch.<branch>.<prefix>.<subkey>` contribute, with the
 * `branch.<branch>.<prefix>.` part stripped. Branch names may contain dots
 * (e.g. `release/1.2`), so the branch/subkey split is anchored on the
 * `.<prefix>.` marker rather than naive dot-splitting.
 *
 * @param entries Map of full git config key → value
 * @param prefix Metadata prefix (e.g. "codehydra")
 * @returns Map of branch name → { subkey: value }
 */
export function parseBranchConfigs(
  entries: ReadonlyMap<string, string>,
  prefix: string
): Map<string, Record<string, string>> {
  const result = new Map<string, Record<string, string>>();
  const branchPrefix = "branch.";
  const marker = `.${prefix}.`;

  for (const [fullKey, value] of entries) {
    if (!fullKey.startsWith(branchPrefix)) continue;
    const markerIndex = fullKey.indexOf(marker);
    if (markerIndex === -1) continue;

    const branch = fullKey.substring(branchPrefix.length, markerIndex);
    const subKey = fullKey.substring(markerIndex + marker.length);
    if (!branch || !subKey) continue;

    let record = result.get(branch);
    if (!record) {
      record = {};
      result.set(branch, record);
    }
    record[subKey] = value;
  }

  return result;
}

/**
 * Tag name marking a worktree the user explicitly adopted into CodeHydra.
 *
 * Adopted worktrees live outside `workspacesDir` (they were created by hand or by
 * another tool), so the directory alone cannot prove ownership. The tag is both the
 * ownership record read by `discover()` and the `external` badge the sidebar renders
 * — `extractTags()` picks up any `tags.*` metadata key without further plumbing. A
 * metadata file alone never makes a worktree managed: only this tag does.
 */
export const EXTERNAL_TAG_NAME = "external";

/** Metadata key holding the external tag (`tags.` prefix + the tag name). */
export const EXTERNAL_TAG_METADATA_KEY = `tags.${EXTERNAL_TAG_NAME}`;

/**
 * Tag value: a neutral grey, quieter than CodeHydra's blue `new` tag — this marks a
 * permanent property of the workspace, not a call to action. The description is the
 * sidebar tooltip, saying what "external" means without spending row width on it.
 *
 * Written once, at adoption. Worktrees adopted before a change here keep whatever
 * value they were adopted with; nothing backfills them.
 */
export const EXTERNAL_TAG_VALUE = JSON.stringify({
  color: "#8b949e",
  description: "Adopted worktree — created outside CodeHydra",
});

/**
 * Global provider managing git worktree operations across all projects.
 *
 * Maintains two internal registries:
 * - Project registry: Maps projectRoot -> { workspacesDir }
 * - Workspace registry: Maps workspacePath -> projectRoot (for metadata resolution)
 *
 *
 * All paths are handled using the Path class for normalized, cross-platform handling.
 */
export class GitWorktreeProvider {
  /**
   * Git config prefix of the legacy metadata store (`branch.<b>.codehydra.*`).
   * Read only to migrate it into metadata files; see `discover()`.
   */
  private static readonly METADATA_CONFIG_PREFIX = "codehydra";

  /** Timeout for fallback fs.rm() when git worktree remove fails */
  private static readonly RM_FALLBACK_TIMEOUT_MS = 30_000;

  private readonly gitClient: IGitClient;
  private readonly fileSystemLayer: FileSystemBoundary;
  private readonly logger: Logger;

  /** Map of normalized project root strings to project registration data */
  private readonly projectRegistry: Map<string, ProjectRegistration> = new Map();

  /** Map of normalized workspace path strings to project root Path (for metadata resolution) */
  private readonly workspaceRegistry: Map<string, Path> = new Map();

  /** Every registered workspace's metadata, held in memory and in its metadata file. */
  private readonly metadataStore: WorkspaceMetadataStore;

  /**
   * Keys a workspace migrated from the legacy git config gets when its config has
   * none — the agent it has been running (the default), so a later change of the
   * default leaves it alone.
   */
  private readonly migrationDefaults: () => Metadata;

  constructor(
    gitClient: IGitClient,
    fileSystemLayer: FileSystemBoundary,
    logger: Logger,
    migrationDefaults: () => Metadata = () => ({})
  ) {
    this.gitClient = gitClient;
    this.fileSystemLayer = fileSystemLayer;
    this.logger = logger;
    this.metadataStore = new WorkspaceMetadataStore(fileSystemLayer, logger);
    this.migrationDefaults = migrationDefaults;
  }

  /**
   * Register a project with this global provider.
   * Must be called before any operations on the project.
   *
   * @param projectRoot Absolute path to the git repository
   * @param workspacesDir Directory where worktrees are created
   * @param previousWorkspacesDirs Workspaces directories left behind by a
   *   workspaces-root migration: worktrees there stay managed, on any branch
   */
  registerProject(
    projectRoot: Path,
    workspacesDir: Path,
    previousWorkspacesDirs: readonly Path[] = []
  ): void {
    this.projectRegistry.set(projectRoot.toString(), {
      workspacesDir,
      previousWorkspacesDirs,
      cleanupInProgress: false,
    });
  }

  /**
   * Unregister a project from this global provider.
   * Removes all workspace registry entries for this project.
   *
   * @param projectRoot Absolute path to the git repository
   */
  unregisterProject(projectRoot: Path): void {
    const projectRootStr = projectRoot.toString();
    this.projectRegistry.delete(projectRootStr);

    // Remove all workspace entries for this project
    for (const [workspaceKey, registeredRoot] of this.workspaceRegistry) {
      if (registeredRoot.toString() === projectRootStr) {
        this.workspaceRegistry.delete(workspaceKey);
        this.metadataStore.forget(new Path(workspaceKey));
      }
    }
  }

  /**
   * Get the project registration for a project root.
   * @throws WorkspaceError if project is not registered
   */
  private getProjectRegistration(projectRoot: Path): ProjectRegistration {
    const registration = this.projectRegistry.get(projectRoot.toString());
    if (!registration) {
      throw new WorkspaceError(
        `Project not registered: ${projectRoot.toString()}. Call registerProject() first.`
      );
    }
    return registration;
  }

  /**
   * Resolve project root from workspace path using the workspace registry.
   * @throws WorkspaceError if workspace is not registered
   */
  private resolveProjectRoot(workspacePath: Path): Path {
    const projectRoot = this.workspaceRegistry.get(workspacePath.toString());
    if (!projectRoot) {
      throw new WorkspaceError(
        `Workspace not registered: ${workspacePath.toString()}. ` +
          `The project may not be open or the workspace was not discovered.`
      );
    }
    return projectRoot;
  }

  /**
   * Register a workspace in the workspace registry.
   * Called internally when workspaces are discovered or created.
   *
   * @param workspacePath Absolute path to the workspace
   * @param projectRoot Project root that owns this workspace
   */
  ensureWorkspaceRegistered(workspacePath: Path, projectRoot: Path): void {
    this.workspaceRegistry.set(workspacePath.toString(), projectRoot);
  }

  /**
   * Validate that a path is a git repository root.
   *
   * @param projectRoot Absolute path to validate
   * @throws WorkspaceError if path is invalid or not a git repository
   */
  async validateRepository(projectRoot: Path): Promise<void> {
    try {
      const isRoot = await this.gitClient.isRepositoryRoot(projectRoot);
      if (!isRoot) {
        throw new WorkspaceError(
          `Path is not a git repository root: ${projectRoot.toString()}. ` +
            `Please select the root directory of your git repository.`
        );
      }
    } catch (error: unknown) {
      if (error instanceof WorkspaceError) {
        throw error;
      }
      const message = getErrorMessage(error, "Unknown error checking repository");
      throw new WorkspaceError(`Failed to validate repository: ${message}`);
    }
  }

  /**
   * Check if a branch is currently checked out in any worktree.
   * @param projectRoot Root of the git repository
   * @param branchName Name of the branch to check
   * @returns Object with checkedOut status and worktree path if found
   */
  private async isBranchCheckedOut(
    projectRoot: Path,
    branchName: string
  ): Promise<{ checkedOut: boolean; worktreePath: Path | null }> {
    const worktrees = await this.gitClient.listWorktrees(projectRoot);
    const worktree = worktrees.find((wt) => wt.branch === branchName);
    return {
      checkedOut: !!worktree,
      worktreePath: worktree?.path ?? null,
    };
  }

  /**
   * Read the legacy `branch.<b>.codehydra.*` metadata of a repository in one git
   * config call, keyed by branch name. Only migration and the add-project picker
   * read it: metadata lives in each worktree's metadata file now.
   */
  private async getLegacyBranchMetadata(
    projectRoot: Path
  ): Promise<ReadonlyMap<string, Readonly<Record<string, string>>>> {
    const prefix = GitWorktreeProvider.METADATA_CONFIG_PREFIX;
    try {
      const entries = await this.gitClient.getGitConfig(projectRoot, {
        regex: `^branch\\..*\\.${prefix}\\.`,
      });
      return parseBranchConfigs(entries, prefix);
    } catch (error: unknown) {
      this.logger.warn("Failed to read legacy metadata config", {
        error: getErrorMessage(error),
      });
      return new Map();
    }
  }

  /** Read a worktree's metadata file, locating it through the worktree's git directory. */
  private async loadMetadataFile(worktreePath: Path): Promise<LoadedMetadata> {
    let file: Path;
    try {
      file = WorkspaceMetadataStore.fileIn(await this.gitClient.getWorktreeGitDir(worktreePath));
    } catch (error: unknown) {
      this.logger
        .scoped({ path: worktreePath.toString() })
        .warn("Failed to locate worktree git directory", { error: getErrorMessage(error) });
      return { file: null, metadata: null };
    }
    try {
      return { file, metadata: await this.metadataStore.read(file) };
    } catch (error: unknown) {
      this.logger
        .scoped({ path: file.toString() })
        .warn("Failed to read workspace metadata file", { error: getErrorMessage(error) });
      return { file, metadata: null };
    }
  }

  /**
   * Discover the workspaces CodeHydra manages for a project.
   *
   * A worktree is managed when CodeHydra created it (it lives under the project's
   * `workspacesDir`, or under one the project had before a workspaces-root
   * migration, whatever is checked out there) or when the user adopted it through
   * the add-project picker (its metadata carries the external tag). Every other
   * worktree of the repository is skipped: agents (Claude's `isolation: "worktree"`,
   * for one) create worktrees of the same repo as scratch space, and those must not
   * surface as workspaces.
   *
   * Loads every managed workspace's metadata file into memory. A managed worktree
   * without one is migrated from the legacy `branch.<b>.codehydra.*` git config:
   * its file is written (`migrationDefaults` fill the keys its config lacks; with
   * neither, the file is still written, as the migration record), then the migrated
   * branches' config sections are removed.
   */
  async discover(projectRoot: Path): Promise<readonly Workspace[]> {
    const registration = this.getProjectRegistration(projectRoot);
    const worktrees = await this.gitClient.listWorktrees(projectRoot);

    // Prune stale worktrees (directory deleted outside of CodeHydra)
    const hasPrunable = worktrees.some((wt) => wt.prunable);
    if (hasPrunable) {
      for (const wt of worktrees) {
        if (wt.prunable) {
          this.logger
            .scoped({ path: wt.path.toString() })
            .warn("Pruning stale worktree", { name: wt.name });
        }
      }
      await this.gitClient.pruneWorktrees(projectRoot);
    }

    const candidates = worktrees.filter((wt) => !wt.isMain && !wt.prunable);
    const loaded = await Promise.all(candidates.map((wt) => this.loadMetadataFile(wt.path)));

    // The legacy config is read only while some worktree still has no file: once
    // every managed worktree is migrated, discovery runs no git config at all.
    const legacy = loaded.some((entry) => entry.metadata === null)
      ? await this.getLegacyBranchMetadata(projectRoot)
      : new Map<string, Readonly<Record<string, string>>>();

    const workspaces: Workspace[] = [];
    const migrations: { path: Path; file: Path; branch: string | null; metadata: Metadata }[] = [];
    candidates.forEach((wt, index) => {
      const { file, metadata: fromFile } = loaded[index]!;
      const fromLegacy = wt.branch ? legacy.get(wt.branch) : undefined;
      let metadata: Record<string, string> = { ...(fromFile ?? fromLegacy ?? {}) };

      const own = isOwnWorktree(registration, wt.path);
      if (!own && metadata[EXTERNAL_TAG_METADATA_KEY] === undefined) {
        this.logger
          .scoped({ path: wt.path.toString() })
          .warn("Skipping unmanaged worktree", { branch: wt.branch });
        return;
      }

      // Register workspace in the workspace registry for metadata resolution
      this.ensureWorkspaceRegistered(wt.path, projectRoot);
      if (file !== null) {
        if (fromFile === null) {
          metadata = { ...this.migrationDefaults(), ...metadata };
          migrations.push({ path: wt.path, file, branch: wt.branch, metadata });
        } else {
          this.metadataStore.track(wt.path, file, metadata);
        }
      }

      workspaces.push({
        // A workspace is named after its branch, wherever its directory is and
        // whatever it is called. Only a detached HEAD falls back to the directory:
        // CodeHydra's own directories are the sanitized branch, so unsanitizing
        // recovers it; an adopted one keeps the name the user gave its directory.
        name: wt.branch ?? (own ? unsanitizeWorkspaceName(wt.name) : wt.name),
        path: wt.path,
        branch: wt.branch,
        metadata,
      });
    });

    if (migrations.length > 0) {
      await this.migrateLegacyMetadata(projectRoot, migrations, legacy);
    }
    return workspaces;
  }

  /**
   * Write the metadata files of worktrees that have none yet, then drop the
   * legacy config sections nothing needs any more.
   *
   * A section goes once its branch's workspace has its file, or when the branch
   * itself is gone (`git branch -D` leaves the sections behind). Sections of a
   * branch that still exists but is not one of this discovery's workspaces stay:
   * the worktree may belong to another CodeHydra instance (a dev build, one with
   * a different workspaces folder) still reading them. A failed write keeps its
   * branch's sections, so the next discovery migrates it again.
   */
  private async migrateLegacyMetadata(
    projectRoot: Path,
    migrations: readonly { path: Path; file: Path; branch: string | null; metadata: Metadata }[],
    legacy: ReadonlyMap<string, Readonly<Record<string, string>>>
  ): Promise<void> {
    const migrated = new Set<string>();
    await Promise.all(
      migrations.map(async ({ path, file, branch, metadata }) => {
        try {
          await this.metadataStore.initialize(path, file, metadata);
          if (branch !== null) migrated.add(branch);
        } catch (error: unknown) {
          // Still usable this session: the write is retried on the next set.
          this.metadataStore.track(path, file, metadata);
          this.logger
            .scoped({ path: path.toString() })
            .warn("Failed to write migrated workspace metadata", {
              error: getErrorMessage(error),
            });
        }
      })
    );
    if (legacy.size === 0) return;

    let liveBranches: ReadonlySet<string>;
    try {
      const branches = await this.gitClient.listBranches(projectRoot);
      liveBranches = new Set(branches.filter((b) => !b.isRemote).map((b) => b.name));
    } catch (error: unknown) {
      this.logger.warn("Failed to list branches for legacy metadata cleanup", {
        error: getErrorMessage(error),
      });
      return;
    }

    const prefix = GitWorktreeProvider.METADATA_CONFIG_PREFIX;
    for (const [branch, entries] of legacy) {
      if (!migrated.has(branch) && liveBranches.has(branch)) continue;
      // `branch.<b>.codehydra.tags.new` lives in section `branch.<b>.codehydra.tags`
      const sections = new Set(
        Object.keys(entries).map((key) => {
          const fullKey = `branch.${branch}.${prefix}.${key}`;
          return fullKey.substring(0, fullKey.lastIndexOf("."));
        })
      );
      for (const section of sections) {
        try {
          await this.gitClient.removeConfigSection(projectRoot, section);
        } catch (error: unknown) {
          this.logger.warn("Failed to remove legacy metadata config", {
            section,
            error: getErrorMessage(error),
          });
        }
      }
    }
  }

  /**
   * List the worktrees of a project that `discover()` would skip — everything the
   * user could still adopt.
   *
   * Feeds the add-project picker, which runs before the project's first discovery,
   * so an adoption still recorded only in the legacy git config counts too.
   *
   * @param projectRoot Root of the git repository
   * @param workspacesDir Directory CodeHydra creates this project's worktrees in
   * @param previousWorkspacesDirs Its directories from before a workspaces-root migration
   */
  async listUnmanagedWorktrees(
    projectRoot: Path,
    workspacesDir: Path,
    previousWorkspacesDirs: readonly Path[] = []
  ): Promise<readonly UnmanagedWorktree[]> {
    const worktrees = await this.gitClient.listWorktrees(projectRoot);
    const candidates = worktrees.filter(
      (wt) =>
        !wt.isMain &&
        !wt.prunable &&
        !isOwnWorktree({ workspacesDir, previousWorkspacesDirs }, wt.path)
    );
    const loaded = await Promise.all(candidates.map((wt) => this.loadMetadataFile(wt.path)));
    const legacy = loaded.some((entry) => entry.metadata === null)
      ? await this.getLegacyBranchMetadata(projectRoot)
      : new Map<string, Readonly<Record<string, string>>>();

    const unmanaged: UnmanagedWorktree[] = [];
    candidates.forEach((wt, index) => {
      const fromFile = loaded[index]!.metadata;
      const metadata = fromFile ?? (wt.branch ? legacy.get(wt.branch) : undefined) ?? {};
      if (metadata[EXTERNAL_TAG_METADATA_KEY] !== undefined) return;

      unmanaged.push({
        // The name the workspace would take, like discover() gives it.
        name: wt.branch ?? wt.name,
        path: wt.path,
        branch: wt.branch,
      });
    });
    return unmanaged;
  }

  /**
   * Adopt an existing worktree so `discover()` treats it as a workspace from now on.
   *
   * Writes the external tag into the worktree's metadata file, so a detached HEAD
   * can be adopted too. Unlike the best-effort metadata write in
   * `createWorkspace()`, a failure here throws: the tag IS the ownership record, so
   * a silent failure would hand the user a workspace that disappears on the next
   * restart.
   *
   * @throws WorkspaceError if the tag cannot be written
   */
  async adoptWorktree(
    projectRoot: Path,
    worktreePath: Path,
    branch: string | null
  ): Promise<Workspace> {
    let metadata: Record<string, string>;
    try {
      const file = WorkspaceMetadataStore.fileIn(
        await this.gitClient.getWorktreeGitDir(worktreePath)
      );
      metadata = {
        ...((await this.metadataStore.read(file)) ?? {}),
        [EXTERNAL_TAG_METADATA_KEY]: EXTERNAL_TAG_VALUE,
      };
      await this.metadataStore.initialize(worktreePath, file, metadata);
    } catch (error: unknown) {
      const message = getErrorMessage(error, "Unknown error");
      throw new WorkspaceError(
        `Failed to adopt worktree at '${worktreePath.toString()}': ${message}`
      );
    }

    this.ensureWorkspaceRegistered(worktreePath, projectRoot);

    return {
      // Named like discover() names it: the branch, else the directory.
      name: branch ?? worktreePath.basename,
      path: worktreePath,
      branch,
      metadata,
    };
  }

  async listBases(projectRoot: Path): Promise<readonly BaseInfo[]> {
    const branches = await this.gitClient.listBranches(projectRoot);
    const worktrees = await this.gitClient.listWorktrees(projectRoot);

    // Build set of branches that have worktrees, and the base recorded for each
    // branch a workspace has checked out
    const branchesWithWorktrees = new Set<string>();
    const recordedBases = new Map<string, string>();
    for (const wt of worktrees) {
      if (wt.branch) {
        branchesWithWorktrees.add(wt.branch);
        const recorded = this.metadataStore.get(wt.path)?.base;
        if (recorded) recordedBases.set(wt.branch, recorded);
      }
    }

    // Build set of local branch names
    const localBranches = new Set<string>();
    for (const branch of branches) {
      if (!branch.isRemote) {
        localBranches.add(branch.name);
      }
    }

    // Compute derives for remote branches with deduplication
    // For each derivable name, track which remote branch should get the derives field
    // Prefer 'origin' remote, then alphabetically first
    const derivesMap = this.computeRemoteDerives(branches, localBranches);

    // Build result with derives and base
    const result: BaseInfo[] = [];

    for (const branch of branches) {
      if (branch.isRemote) {
        // Remote branch: derives if no local counterpart and we're the preferred remote
        const derives = derivesMap.get(branch.name);
        const baseInfo: BaseInfo = {
          name: branch.name,
          isRemote: true,
          base: branch.name, // Remote's base is itself
        };
        if (derives !== undefined) {
          result.push({ ...baseInfo, derives });
        } else {
          result.push(baseInfo);
        }
      } else {
        // Local branch: derives if no worktree exists
        const hasWorktree = branchesWithWorktrees.has(branch.name);

        // Compute base: its workspace's recorded base or matching origin/* branch
        let base: string | undefined;
        const recordedBase = recordedBases.get(branch.name);
        if (recordedBase) {
          base = recordedBase;
        } else {
          // Check for matching origin/* branch
          const originBranch = `origin/${branch.name}`;
          const hasOriginBranch = branches.some((b) => b.isRemote && b.name === originBranch);
          if (hasOriginBranch) {
            base = originBranch;
          }
        }

        // Build BaseInfo with conditional optional properties
        const baseInfo: BaseInfo = {
          name: branch.name,
          isRemote: false,
        };
        if (base !== undefined) {
          result.push(
            hasWorktree ? { ...baseInfo, base } : { ...baseInfo, base, derives: branch.name }
          );
        } else {
          result.push(hasWorktree ? baseInfo : { ...baseInfo, derives: branch.name });
        }
      }
    }

    return result;
  }

  /**
   * Compute derives for remote branches with deduplication across remotes.
   * For branches that exist on multiple remotes (e.g., origin/feature, upstream/feature),
   * only one should get the derives field. Preference: 'origin' first, then alphabetically.
   *
   * @returns Map from full remote branch name to derives value (or undefined if no derives)
   */
  private computeRemoteDerives(
    branches: readonly { name: string; isRemote: boolean }[],
    localBranches: Set<string>
  ): Map<string, string | undefined> {
    // Map: derivable name -> array of [remote, fullBranchName]
    const derivableToRemotes = new Map<string, Array<[string, string]>>();

    for (const branch of branches) {
      if (!branch.isRemote) continue;

      // Extract remote prefix and branch name
      // e.g., "origin/feature" -> remote="origin", branchName="feature"
      // e.g., "origin/feature/login" -> remote="origin", branchName="feature/login"
      const slashIndex = branch.name.indexOf("/");
      if (slashIndex === -1) continue;

      const remote = branch.name.substring(0, slashIndex);
      const branchName = branch.name.substring(slashIndex + 1);

      // Skip if local branch exists
      if (localBranches.has(branchName)) continue;

      if (!derivableToRemotes.has(branchName)) {
        derivableToRemotes.set(branchName, []);
      }
      derivableToRemotes.get(branchName)!.push([remote, branch.name]);
    }

    // Build result map: prefer 'origin', then alphabetically first
    const result = new Map<string, string | undefined>();

    for (const [branchName, remotes] of derivableToRemotes) {
      // Sort: 'origin' first, then alphabetically
      remotes.sort(([a], [b]) => {
        if (a === "origin") return -1;
        if (b === "origin") return 1;
        return a.localeCompare(b);
      });

      // First one gets derives, others get undefined
      for (let i = 0; i < remotes.length; i++) {
        const [, fullBranchName] = remotes[i]!;
        result.set(fullBranchName, i === 0 ? branchName : undefined);
      }
    }

    return result;
  }

  async updateBases(projectRoot: Path): Promise<UpdateBasesResult> {
    const remotes = await this.gitClient.listRemotes(projectRoot);

    const fetchedRemotes: string[] = [];
    const failedRemotes: { remote: string; error: string }[] = [];

    for (const remote of remotes) {
      try {
        await this.gitClient.fetch(projectRoot, remote);
        fetchedRemotes.push(remote);
      } catch (error: unknown) {
        const errorMessage = getErrorMessage(error, "Unknown fetch error");
        failedRemotes.push({ remote, error: errorMessage });
      }
    }

    return { fetchedRemotes, failedRemotes };
  }

  async createWorkspace(
    projectRoot: Path,
    name: string,
    baseBranch: string,
    tracking?: string
  ): Promise<Workspace> {
    const registration = this.getProjectRegistration(projectRoot);

    // Sanitize the name for filesystem (/ -> %)
    const sanitizedName = sanitizeWorkspaceName(name);

    // Compute the worktree path using the configured workspaces directory
    const worktreePath = new Path(registration.workspacesDir, sanitizedName);

    // Check if branch already exists (local branches only)
    const branches = await this.gitClient.listBranches(projectRoot);
    const branchExists = branches.some((b) => b.name === name && !b.isRemote);

    // Validate tracking ref is a known remote branch
    if (tracking !== undefined) {
      const isRemoteRef = branches.some((b) => b.name === tracking && b.isRemote);
      if (!isRemoteRef) {
        throw new WorkspaceError(
          `Tracking ref '${tracking}' is not a known remote branch. ` +
            `Fetch remotes first or verify the branch name.`
        );
      }
    }

    let createdBranch = false;

    if (branchExists) {
      // Branch exists - check if already checked out in a worktree
      const { checkedOut, worktreePath: existingPath } = await this.isBranchCheckedOut(
        projectRoot,
        name
      );
      if (checkedOut) {
        throw new WorkspaceError(
          `Branch '${name}' is already checked out in worktree at '${existingPath?.toString()}'`
        );
      }
      // Branch exists and not checked out - will use existing branch
      // The baseBranch is saved in config for tracking purposes regardless of whether it matches

      // If tracking is set, reconfigure upstream
      if (tracking !== undefined) {
        const slashIndex = tracking.indexOf("/");
        if (slashIndex !== -1) {
          const remote = tracking.substring(0, slashIndex);
          const remoteBranch = tracking.substring(slashIndex + 1);
          try {
            await this.gitClient.setBranchConfig(projectRoot, name, "remote", remote);
            await this.gitClient.setBranchConfig(
              projectRoot,
              name,
              "merge",
              `refs/heads/${remoteBranch}`
            );
          } catch (error: unknown) {
            const message = getErrorMessage(error, "Unknown error");
            this.logger.warn("Failed to configure upstream tracking", {
              branch: name,
              tracking,
              error: message,
            });
          }
        }
      }
    } else {
      // Branch doesn't exist - create it
      try {
        if (tracking !== undefined) {
          await this.gitClient.createBranch(projectRoot, name, tracking, { track: true });
        } else {
          await this.gitClient.createBranch(projectRoot, name, baseBranch);
        }
        createdBranch = true;
      } catch (error: unknown) {
        const message = getErrorMessage(error, "Unknown error creating branch");
        throw new WorkspaceError(message);
      }
    }

    // Create the worktree
    try {
      await this.gitClient.addWorktree(projectRoot, worktreePath, name);
    } catch (error: unknown) {
      // Rollback: only delete branch if we created it
      if (createdBranch) {
        try {
          await this.gitClient.deleteBranch(projectRoot, name);
        } catch {
          // Ignore rollback errors
        }
      }

      const message = getErrorMessage(error, "Unknown error creating worktree");
      throw new WorkspaceError(message);
    }

    // Register workspace in the workspace registry
    this.ensureWorkspaceRegistered(worktreePath, projectRoot);

    // Record the base in the new worktree's metadata file (non-critical - log
    // warning on failure; the file is created by the next metadata write)
    try {
      const file = WorkspaceMetadataStore.fileIn(
        await this.gitClient.getWorktreeGitDir(worktreePath)
      );
      await this.metadataStore.initialize(worktreePath, file, { base: baseBranch });
    } catch (error: unknown) {
      const message = getErrorMessage(error, "Unknown error");
      this.logger.warn("Failed to save base branch metadata", { branch: name, error: message });
    }

    return {
      name,
      path: worktreePath,
      branch: name,
      metadata: { base: baseBranch },
    };
  }

  async removeWorkspace(
    projectRoot: Path,
    workspacePath: Path,
    deleteBase: boolean
  ): Promise<RemovalResult> {
    // Cannot remove main worktree - use Path.equals() for proper comparison
    if (workspacePath.equals(projectRoot)) {
      throw new WorkspaceError("Cannot remove the main worktree");
    }

    // Get the branch name before removal (also checks if worktree exists)
    const worktrees = await this.gitClient.listWorktrees(projectRoot);
    const worktree = worktrees.find((wt) => wt.path.equals(workspacePath));
    // A workspace CodeHydra created has a branch named after its directory (see
    // createWorkspace), so the basename recovers it in both cases where the worktree
    // entry can't supply one: the entry is missing (retry after a partial failure), or
    // HEAD is detached — a rebase that stopped on a conflict leaves it that way, and
    // worktree.branch is then null. Falling back matters: on null, the
    // branch delete below is skipped and the branch is orphaned with no error. Deleting is still guarded by the branch-exists check in step 3, so a
    // workspace whose basename maps to no branch (detached on purpose) stays a no-op.
    //
    // That derivation only holds inside workspacesDir. An adopted worktree sits in a
    // directory the user named, unrelated to its branch, so guessing there could hand
    // deleteBranch an unrelated branch that happens to share the directory name — we
    // skip the branch work entirely rather than delete something we only inferred.
    const registration = this.projectRegistry.get(projectRoot.toString());
    const derivedBranch =
      registration && isOwnWorktree(registration, workspacePath)
        ? unsanitizeWorkspaceName(workspacePath.basename)
        : "";
    const branchName = worktree?.branch ?? derivedBranch;

    // Step 1: Try to remove worktree (its metadata file goes with it), save error if it fails
    // We save the error to throw later, after attempting branch deletion
    let worktreeError: Error | null = null;
    if (worktree) {
      try {
        await this.gitClient.removeWorktree(projectRoot, workspacePath);
      } catch (error) {
        // git worktree remove can fail for various reasons (stale .git,
        // Windows long paths, locked files, etc.) — fall back to rm + prune
        this.logger
          .scoped({ path: workspacePath.toString() })
          .warn("Worktree removal failed; trying recursive rm", { error: getErrorMessage(error) });
        // Time the fallback. `fs.rm`'s internal retries are invisible from
        // here — a removal rescued on the third attempt looks exactly like one
        // that succeeded immediately — so the only signal that a holder let go
        // late (rather than never having been there) is how long this took.
        // Without it, "should the retry budget go up or down?" is unanswerable
        // from a bug report, which is precisely where that question lands.
        const rmStart = Date.now();
        try {
          await this.fileSystemLayer.rm(workspacePath, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 200,
            timeout: GitWorktreeProvider.RM_FALLBACK_TIMEOUT_MS,
          });
          await this.gitClient.pruneWorktrees(projectRoot);
          this.logger
            .scoped({ path: workspacePath.toString() })
            .info("Removed workspace via fallback", { elapsedMs: Date.now() - rmStart });
        } catch (fallbackError) {
          // Log BOTH failures. Reports of this only ever carried the git error,
          // which names the directory but never says what was holding it; the
          // post-mortem scan runs later, by which point the transient holder is
          // usually gone. The rm error carries the errno (EPERM/EBUSY/ENOTEMPTY
          // /ETIMEDOUT), which at least distinguishes "still locked" from "took
          // too long".
          this.logger
            .scoped({ path: workspacePath.toString() })
            .warn("Recursive rm fallback failed too", {
              error: getErrorMessage(fallbackError),
              elapsedMs: Date.now() - rmStart,
            });
          worktreeError = error as Error;
        }
      }
    }

    // Step 2: Delete the branch (always attempt if requested)
    // This ensures branch is deleted even if worktree removal failed
    // (e.g., due to Windows file locks - directory cleanup happens at startup)
    let baseDeleted = false;
    if (deleteBase && branchName) {
      // Check if branch exists before attempting deletion
      const branches = await this.gitClient.listBranches(projectRoot);
      const branchExists = branches.some((b) => b.name === branchName && !b.isRemote);

      if (branchExists) {
        try {
          await this.gitClient.deleteBranch(projectRoot, branchName);
          baseDeleted = true;
        } catch (error) {
          // Only throw branch error if there was no worktree error
          // (worktree error takes precedence)
          if (!worktreeError) {
            throw error;
          }
          baseDeleted = false;
        }
      } else {
        // Branch already deleted - treat as success (idempotent)
        this.logger.debug("Branch already deleted, skipping", { branch: branchName });
        baseDeleted = true;
      }
    }

    // Step 3: Throw saved worktree error (after branch deletion attempted)
    if (worktreeError) {
      throw worktreeError;
    }

    // Prune stale worktree entries
    await this.gitClient.pruneWorktrees(projectRoot);

    // Remove workspace from registry
    this.workspaceRegistry.delete(workspacePath.toString());
    this.metadataStore.forget(workspacePath);

    return {
      workspaceRemoved: true,
      baseDeleted,
    };
  }

  async isDirty(workspacePath: Path): Promise<boolean> {
    try {
      const status = await this.gitClient.getStatus(workspacePath);
      return status.isDirty;
    } catch (error) {
      // A status query can race with workspace deletion: the worktree is torn
      // down on disk while the workspace is still in the in-memory list, so a
      // get-status request resolves and reaches here. A workspace that no longer
      // exists has no uncommitted changes to report. Only swallow that specific
      // case — genuine git failures must still surface (e.g. the delete-preflight
      // dirty check relies on this to avoid discarding work).
      //
      // The tell is the `.git` marker, not the directory: worktree removal is not
      // atomic (notably on Windows, where locked files force a retrying recursive
      // rm), so the directory can linger after `.git` is already unlinked. In that
      // window git reports "not a git repository" while readdir on the directory
      // still succeeds, so a directory-exists check would wrongly re-throw.
      if (!(await this.isGitWorktree(workspacePath))) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Best-effort check for whether `path` is still a git worktree, i.e. carries a
   * `.git` marker. Used only to classify an already-failed git operation, so it
   * is not subject to the TOCTOU concerns that motivate omitting a general
   * exists() helper. Both "directory gone" and "directory present but `.git`
   * unlinked" (a half-removed worktree) report false.
   */
  private async isGitWorktree(path: Path): Promise<boolean> {
    try {
      const entries = await this.fileSystemLayer.readdir(path);
      return entries.some((entry) => entry.name === ".git");
    } catch (error) {
      if (error instanceof FileSystemError && error.fsCode === "ENOENT") {
        return false;
      }
      // Some other filesystem problem (permissions, etc.) — assume it is still a
      // worktree so the original git error is surfaced rather than masked.
      return true;
    }
  }

  async countUnmergedCommits(workspacePath: Path): Promise<number> {
    try {
      const branch = await this.gitClient.getCurrentBranch(workspacePath);
      if (!branch) return 0;

      const projectRoot = this.workspaceRegistry.get(workspacePath.toString());
      if (!projectRoot) return 0;

      let base = this.metadataStore.get(workspacePath)?.base;
      if (!base) {
        base = await this.defaultBase(projectRoot);
      }
      if (!base) return 0;

      return await this.gitClient.countUnmergedCommits(projectRoot, branch, base);
    } catch {
      return 0;
    }
  }

  /**
   * Returns the default base branch for creating new workspaces.
   *
   * Detection order:
   * 1. The remote's recorded default branch (refs/remotes/<remote>/HEAD symref,
   *    maintained by clone/fetch) — covers repos whose default is develop/trunk/etc.
   *    and self-heals after a remote default-branch rename on the next refresh.
   * 2. The repository's own HEAD symref (clone-time default in bare clones,
   *    checked-out branch in local repos).
   * 3. Legacy hardcoded order: origin/main -> main -> origin/master -> master.
   *
   * Every candidate must exist in listBases() — the result is used as the dialog's
   * preselected entry, so it must be selectable. Prefers remote-tracking entries
   * over local ones to ensure proper tracking. Purely local: never hits the network.
   *
   * @param projectRoot Root of the git repository
   * @param bases Pre-fetched bases to reuse; when omitted, listBases() is called.
   *   Callers that already enumerated bases (e.g. the get-project-bases list
   *   hook) pass them to avoid a second full branch enumeration.
   * @returns Promise resolving to the default base branch, or undefined if none found
   */
  async defaultBase(projectRoot: Path, bases?: readonly BaseInfo[]): Promise<string | undefined> {
    try {
      const resolvedBases = bases ?? (await this.listBases(projectRoot));
      const branchNames = new Set(resolvedBases.map((b) => b.name));

      // Resolve a detected branch name to a selectable base, preferring remote-tracking
      const pick = (branchName: string | null, remote?: string): string | undefined => {
        if (!branchName) return undefined;
        if (remote !== undefined && branchNames.has(`${remote}/${branchName}`)) {
          return `${remote}/${branchName}`;
        }
        return branchNames.has(branchName) ? branchName : undefined;
      };

      const remotes = await this.gitClient.listRemotes(projectRoot);
      const remote = remotes.includes("origin") ? "origin" : remotes[0];

      if (remote !== undefined) {
        const remoteDefault = await this.gitClient.getDefaultBranch(projectRoot, remote);
        const base = pick(remoteDefault, remote);
        if (base !== undefined) return base;
      }

      const headDefault = await this.gitClient.getDefaultBranch(projectRoot);
      const headBase = pick(headDefault, remote);
      if (headBase !== undefined) return headBase;

      // Legacy fallback for repos where no symref answer exists
      for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
        if (branchNames.has(candidate)) {
          return candidate;
        }
      }
      return undefined;
    } catch (error: unknown) {
      const message = getErrorMessage(error, "Unknown error");
      this.logger.warn("Failed to get default base branch", { error: message });
      return undefined;
    }
  }

  /**
   * Removes workspace directories that are not registered with git.
   * Handles cases where `git worktree remove` unregistered a worktree
   * but failed to delete its directory (e.g., due to locked files).
   *
   * Runs at project startup (non-blocking). Errors are logged but not thrown,
   * allowing cleanup to retry on next startup.
   *
   * Security: Skips symlinks and validates paths stay within workspacesDir.
   *
   * @param projectRoot Root of the git repository
   * @returns Result indicating how many directories were removed and any failures
   */
  async cleanupOrphanedWorkspaces(projectRoot: Path): Promise<CleanupResult> {
    const emptyResult: CleanupResult = { removedCount: 0, failedPaths: [] };
    const registration = this.projectRegistry.get(projectRoot.toString());
    if (!registration) {
      return emptyResult;
    }

    // Concurrency guard - only one cleanup at a time per project
    if (registration.cleanupInProgress) {
      return emptyResult;
    }
    registration.cleanupInProgress = true;

    try {
      return await this.doCleanupOrphanedWorkspaces(projectRoot, registration.workspacesDir);
    } finally {
      registration.cleanupInProgress = false;
    }
  }

  private async doCleanupOrphanedWorkspaces(
    projectRoot: Path,
    workspacesDir: Path
  ): Promise<CleanupResult> {
    const emptyResult: CleanupResult = { removedCount: 0, failedPaths: [] };

    // Get registered worktrees
    let worktrees;
    try {
      worktrees = await this.gitClient.listWorktrees(projectRoot);
    } catch (error) {
      // Cannot determine registered worktrees - abort cleanup silently
      this.logger.warn("Failed to list worktrees for cleanup", { error: getErrorMessage(error) });
      return emptyResult;
    }

    // Build normalized path set for fast lookup (using Path.toString())
    const registeredPaths = new Set(worktrees.map((wt) => wt.path.toString()));

    // Read workspacesDir
    let entries;
    try {
      entries = await this.fileSystemLayer.readdir(workspacesDir);
    } catch {
      // workspacesDir doesn't exist yet or can't be read - nothing to clean
      return emptyResult;
    }

    const failedPaths: Array<{ path: string; error: string }> = [];
    let removedCount = 0;

    for (const entry of entries) {
      // Skip non-directories
      if (!entry.isDirectory) {
        continue;
      }

      // Skip symlinks (security)
      if (entry.isSymbolicLink) {
        continue;
      }

      // Build full path using Path
      const fullPath = new Path(workspacesDir, entry.name);

      // Validate path stays within workspacesDir (security - path traversal)
      // Use isChildOf for proper containment check
      if (!fullPath.isChildOf(workspacesDir) && !fullPath.equals(workspacesDir)) {
        continue;
      }

      // Skip if registered
      if (registeredPaths.has(fullPath.toString())) {
        continue;
      }

      // Re-check registration before delete (TOCTOU protection)
      try {
        const currentWorktrees = await this.gitClient.listWorktrees(projectRoot);
        const nowRegistered = currentWorktrees.some((wt) => wt.path.equals(fullPath));
        if (nowRegistered) {
          // Workspace was created concurrently - skip
          continue;
        }
      } catch {
        // Cannot verify - skip this entry to be safe
        continue;
      }

      // Delete the orphaned directory
      try {
        await this.fileSystemLayer.rm(fullPath, { recursive: true, force: true });
        this.logger.scoped({ path: fullPath.toString() }).info("Removed orphaned workspace");
        removedCount++;
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        this.logger
          .scoped({ path: fullPath.toString() })
          .warn("Failed to remove orphaned workspace", { error: errorMessage });
        failedPaths.push({ path: fullPath.toString(), error: errorMessage });
      }
    }

    return { removedCount, failedPaths };
  }

  /**
   * The metadata the store holds for a registered workspace, loading its file on
   * first use (a workspace whose file could not be written at creation, say).
   * @throws WorkspaceError if the workspace is not registered or not a worktree
   */
  private async heldMetadata(workspacePath: Path): Promise<Metadata> {
    this.resolveProjectRoot(workspacePath);
    const held = this.metadataStore.get(workspacePath);
    if (held) return held;

    let file: Path;
    try {
      file = WorkspaceMetadataStore.fileIn(await this.gitClient.getWorktreeGitDir(workspacePath));
    } catch {
      throw new WorkspaceError(
        `Workspace not found: ${workspacePath.toString()}`,
        "WORKSPACE_NOT_FOUND"
      );
    }
    const metadata = (await this.metadataStore.read(file)) ?? {};
    this.metadataStore.track(workspacePath, file, metadata);
    return metadata;
  }

  /**
   * Set a metadata value for a workspace. Replaces the workspace's metadata file;
   * works on any worktree, detached HEAD included.
   *
   * @param workspacePath Absolute path to the workspace
   * @param key Metadata key (see `isValidMetadataKey`)
   * @param value Value to set, or null to delete the key
   * @throws WorkspaceError with code "INVALID_METADATA_KEY" if key format invalid
   */
  async setMetadata(workspacePath: Path, key: string, value: string | null): Promise<void> {
    // Validate key format
    if (!isValidMetadataKey(key)) {
      throw new WorkspaceError(
        `Invalid metadata key '${key}': must start with a letter, contain only letters, digits, and hyphens, and not end with a hyphen`,
        "INVALID_METADATA_KEY"
      );
    }

    await this.heldMetadata(workspacePath);
    await this.metadataStore.set(workspacePath, key, value);
  }

  /**
   * Get all metadata for a workspace, every tier included. Served from memory.
   *
   * @param workspacePath Absolute path to the workspace
   * @returns The workspace's metadata record
   */
  async getMetadata(workspacePath: Path): Promise<Readonly<Record<string, string>>> {
    return { ...(await this.heldMetadata(workspacePath)) };
  }
}
