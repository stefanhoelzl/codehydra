/**
 * LocalProjectModule - Sole owner of project state and persistence for ALL projects.
 *
 * Manages internal state (projects map), persists project configs to disk,
 * and responds to resolve hook points across operations.
 *
 * Hook registrations:
 * - resolve-project: shared project resolution (projectPath → projectId + projectName)
 * - project:open  → resolve:  validate .git exists for local paths
 * - project:open  → register: generate ID, persist, add to internal state (all projects)
 * - project:close → resolve:  look up projectPath in config to get remoteUrl
 * - project:close → close:    remove from internal state and config (all projects),
 *                             and delete the project's own directory for a local
 *                             project closed with removeLocalRepo (the remote
 *                             branch of that flag belongs to RemoteProjectModule)
 * - app:start     → start:    load ALL saved project configs
 */

import * as crypto from "node:crypto";
import nodePath from "path";
import type { IntentModule } from "../intents/lib/module";
import type { HookContext, HookOutput } from "../intents/lib/operation";
import type { ProjectId } from "../shared/api/types";
import { projectPathSchema } from "../intents/contract";
import type { ProjectPath } from "../intents/contract";
import { Path } from "../utils/path/path";
import {
  managedClonePath,
  managedProjectDirName,
  projectDirName,
} from "../boundaries/platform/paths";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import type { Logger } from "../boundaries/platform/logging";
import type { ProjectConfig } from "../shared/types/project";
import { ProjectStoreError, getErrorMessage } from "../shared/errors/service-errors";
import type { GitWorktreeProvider } from "../boundaries/platform/git-worktree-provider";
import {
  OPEN_PROJECT_OPERATION_ID,
  type OpenProjectIntent,
  type PrepareHookResult,
  type ResolveHookResult,
  type RegisterHookInput,
  type RegisterHookResult,
} from "../intents/open-project";
import type { UiPresenter } from "./presentation/presentation-module";
import type { Dispatcher } from "../intents/lib/dispatcher";
import { notify } from "./presentation/notification-card";
import type { IGitClient } from "../boundaries/platform/git-client";
import {
  CLOSE_PROJECT_OPERATION_ID,
  type CloseProjectIntent,
  type CloseResolveHookResult,
  type CloseHookInput,
  type CloseHookResult,
} from "../intents/close-project";
import { APP_READY_OPERATION_ID, type LoadProjectsResult } from "../intents/app-ready";
import {
  RESOLVE_PROJECT_OPERATION_ID,
  type ResolveHookInput as ResolveProjectHookInput,
  type ResolveHookResult as ResolveProjectHookResult,
} from "../intents/resolve-project";
import {
  LIST_PROJECTS_OPERATION_ID,
  type ListProjectsHookResult,
  type ListProjectsHookEntry,
} from "../intents/list-projects";

// =============================================================================
// Types
// =============================================================================

/**
 * Internal representation of a project tracked by this module.
 * No remoteUrl — LocalProjectModule is unaware of remote concerns.
 */
export interface LocalProject {
  readonly id: ProjectId;
  readonly name: string;
  readonly path: Path;
}

/**
 * Dependencies for LocalProjectModule.
 */
export interface LocalProjectModuleDeps {
  readonly projectsDir: string;
  /** Where managed (URL-cloned) projects are cloned to; their paths derive from it. */
  readonly remotesDir: string;
  readonly fs: Pick<
    FileSystemBoundary,
    "readdir" | "readFile" | "writeFile" | "mkdir" | "unlink" | "rm"
  >;
  readonly gitWorktreeProvider: Pick<GitWorktreeProvider, "validateRepository">;
  readonly ui: Pick<UiPresenter, "dialog">;
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
  readonly gitClient: Pick<IGitClient, "isRepositoryRoot" | "init">;
  readonly logger: Logger;
}

// =============================================================================
// Private ID Generation
// =============================================================================

function normalizePathForId(absolutePath: string): string {
  let normalized = nodePath.normalize(absolutePath);
  normalized = normalized.replace(/\\/g, "/");
  normalized = normalized.replace(/\/+/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

function generateProjectId(absolutePath: string): ProjectId {
  const normalizedPath = normalizePathForId(absolutePath);
  const basename = normalizedPath.split("/").pop() ?? "";
  const safeName =
    basename
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "root";
  const hash = crypto.createHash("sha256").update(normalizedPath).digest("hex").slice(0, 8);
  return `${safeName}-${hash}` as ProjectId;
}

// =============================================================================
// Private Persistence Helpers
// =============================================================================

type ProjectFs = LocalProjectModuleDeps["fs"];

/** Where project records and managed clones live. */
interface StoreDirs {
  readonly projectsDir: string;
  readonly remotesDir: string;
}

/**
 * A record read back from disk: the config, the directory it was found in, and
 * whether it is in the legacy managed shape that still stores the clone path.
 */
interface StoredProject {
  readonly config: ProjectConfig;
  readonly dirName: string;
  readonly legacy: boolean;
}

/**
 * Whether a project is managed in the current layout: cloned from `remoteUrl`
 * into exactly the place that URL derives. Only then may its record drop the
 * path — anything else keeps storing it, so no project is reopened somewhere
 * it is not.
 */
function isManaged(dirs: StoreDirs, projectPath: string, remoteUrl: string | undefined): boolean {
  return (
    remoteUrl !== undefined && managedClonePath(dirs.remotesDir, remoteUrl).equals(projectPath)
  );
}

/**
 * The directory a project's record belongs in: a managed project's is named
 * after its URL, so the record survives the clone moving; every other
 * project's is named after its path.
 */
function recordDirName(dirs: StoreDirs, projectPath: string, remoteUrl?: string): string {
  return remoteUrl !== undefined && isManaged(dirs, projectPath, remoteUrl)
    ? managedProjectDirName(remoteUrl)
    : projectDirName(projectPath);
}

/**
 * Parse one record. A managed project's record holds only its URL and the
 * path is derived from it; a local project's holds its path. The legacy
 * managed shape holds both.
 */
function parseRecord(dirs: StoreDirs, content: string): Omit<StoredProject, "dirName"> | undefined {
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as { path?: unknown; remoteUrl?: unknown };
  const remoteUrl = typeof record.remoteUrl === "string" ? record.remoteUrl : undefined;

  if (typeof record.path === "string") {
    const path = projectPathSchema.parse(new Path(record.path).toString());
    return {
      config: { path, ...(remoteUrl !== undefined && { remoteUrl }) },
      legacy: isManaged(dirs, path, remoteUrl),
    };
  }
  if (remoteUrl !== undefined) {
    const path = projectPathSchema.parse(managedClonePath(dirs.remotesDir, remoteUrl).toString());
    return { config: { path, remoteUrl }, legacy: false };
  }
  return undefined;
}

async function saveProject(
  fs: ProjectFs,
  dirs: StoreDirs,
  projectPath: ProjectPath,
  remoteUrl?: string
): Promise<void> {
  const normalizedPath = projectPathSchema.parse(new Path(projectPath).toString());
  const managed = remoteUrl !== undefined && isManaged(dirs, normalizedPath, remoteUrl);
  const projectDir = nodePath.join(
    dirs.projectsDir,
    recordDirName(dirs, normalizedPath, remoteUrl)
  );
  const configPath = nodePath.join(projectDir, "config.json");

  const record = managed
    ? { remoteUrl }
    : { path: normalizedPath, ...(remoteUrl !== undefined && { remoteUrl }) };

  try {
    await fs.mkdir(projectDir);
    await fs.writeFile(configPath, JSON.stringify(record, null, 2));
  } catch (error: unknown) {
    throw new ProjectStoreError(`Failed to save project: ${getErrorMessage(error)}`);
  }
}

async function loadAllProjects(fs: ProjectFs, dirs: StoreDirs): Promise<readonly StoredProject[]> {
  const results: StoredProject[] = [];

  let entries;
  try {
    entries = await fs.readdir(dirs.projectsDir);
  } catch {
    // Directory doesn't exist or other error - nothing stored
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const configPath = nodePath.join(dirs.projectsDir, entry.name, "config.json");
    try {
      const stored = parseRecord(dirs, await fs.readFile(configPath));
      if (stored) results.push({ ...stored, dirName: entry.name });
    } catch {
      // Skip invalid entries (ENOENT, malformed JSON, invalid path, etc.)
      continue;
    }
  }

  return results;
}

async function loadAllProjectConfigs(
  fs: ProjectFs,
  dirs: StoreDirs
): Promise<readonly ProjectConfig[]> {
  return (await loadAllProjects(fs, dirs)).map((stored) => stored.config);
}

async function getProjectConfig(
  fs: ProjectFs,
  dirs: StoreDirs,
  projectPath: string
): Promise<ProjectConfig | undefined> {
  const normalizedPath = new Path(projectPath).toString();

  // First, try the path-hashed location (every local project)
  const configPath = nodePath.join(dirs.projectsDir, projectDirName(normalizedPath), "config.json");
  try {
    const stored = parseRecord(dirs, await fs.readFile(configPath));
    if (stored?.config.path === normalizedPath) return stored.config;
  } catch {
    // Not there - try scanning all records
  }

  // Fallback: scan every record. A managed project's lives in a URL-named
  // directory and yields its path only once parsed.
  const allConfigs = await loadAllProjectConfigs(fs, dirs);
  return allConfigs.find((config) => config.path === normalizedPath);
}

/**
 * Remove a record directory's config.json, then its workspaces directory and
 * itself — each only if empty. A workspaces directory still holding worktrees
 * is evidence of a failed deletion, worth keeping.
 */
async function removeRecordDir(fs: ProjectFs, projectDir: string): Promise<void> {
  try {
    await fs.unlink(nodePath.join(projectDir, "config.json"));
  } catch {
    // Not there - the directory may still hold an empty workspaces dir
  }
  try {
    await fs.rm(nodePath.join(projectDir, "workspaces"));
  } catch {
    // ENOTEMPTY (workspaces exist) or ENOENT (doesn't exist) - that's fine
  }
  try {
    await fs.rm(projectDir);
  } catch {
    // ENOTEMPTY or ENOENT - that's fine
  }
}

async function removeProject(
  fs: ProjectFs,
  dirs: StoreDirs,
  projectPath: string,
  remoteUrl?: string
): Promise<void> {
  // A managed project's record sits apart from its worktrees, which stay in
  // the path-named directory: clean both.
  const recordDir = recordDirName(dirs, projectPath, remoteUrl);
  const pathDir = projectDirName(projectPath);
  for (const dirName of new Set([recordDir, pathDir])) {
    await removeRecordDir(fs, nodePath.join(dirs.projectsDir, dirName));
  }
}

/**
 * Rewrite legacy managed records — `{path, remoteUrl}` in the path-named
 * directory — as `{remoteUrl}` in the URL-named one. Best-effort: a record
 * that cannot be moved keeps working in its old shape and is tried again at
 * the next start.
 */
async function migrateLegacyRecords(
  fs: ProjectFs,
  dirs: StoreDirs,
  stored: readonly StoredProject[],
  logger: Logger
): Promise<void> {
  for (const { config, dirName, legacy } of stored) {
    if (!legacy || config.remoteUrl === undefined) continue;
    try {
      await saveProject(fs, dirs, config.path, config.remoteUrl);
      if (dirName !== managedProjectDirName(config.remoteUrl)) {
        // Only the record moves: the old directory still holds the worktrees.
        await fs.unlink(nodePath.join(dirs.projectsDir, dirName, "config.json"));
      }
    } catch (error: unknown) {
      logger.warn("Failed to migrate project record", {
        projectPath: config.path,
        error: getErrorMessage(error),
      });
    }
  }
}

// =============================================================================
// Module Factory
// =============================================================================

/**
 * Create a LocalProjectModule that owns project state and persistence for ALL projects.
 *
 * @param deps - FileSystemBoundary for persistence, GitWorktreeProvider for .git validation
 * @returns IntentModule with hook handlers for project:open, project:close, app:start
 */
export function createLocalProjectModule(deps: LocalProjectModuleDeps): IntentModule {
  const { projectsDir, remotesDir, fs, gitWorktreeProvider, ui, dispatcher, gitClient, logger } =
    deps;
  const dirs: StoreDirs = { projectsDir, remotesDir };

  /** Internal state: all projects keyed by normalized path string. */
  // Keyed by the branded project path, so a key can be handed straight back to the
  // contract (e.g. the list-projects hook result) without re-minting the brand.
  const projects = new Map<ProjectPath, LocalProject>();

  /**
   * Delete a local project's own directory. Best-effort: by the time the
   * close hook runs the project is already out of internal state and its
   * workspaces are gone, so throwing would leave the app inconsistent without
   * saving the directory. Instead say so — a directory the user explicitly
   * asked to delete surviving in silence is the worse outcome.
   */
  async function removeLocalDirectory(projectPath: string): Promise<void> {
    try {
      await fs.rm(projectPath, { recursive: true, force: true });
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("Failed to remove project directory", { projectPath, error: message });
      notify(dispatcher, {
        type: "error",
        title: "Could not remove the project directory",
        message: `${projectPath} is still on disk: ${message}`,
        dismissible: true,
      });
    }
  }

  return {
    name: "local-project",
    hooks: {
      // resolve-project -> resolve (single registration replaces 5 per-operation hooks)
      [RESOLVE_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<HookOutput<ResolveProjectHookResult>> => {
            const { projectPath } = ctx as ResolveProjectHookInput;
            const normalizedKey = projectPathSchema.parse(new Path(projectPath).toString());
            const project = projects.get(normalizedKey);
            if (!project) return { result: {} };
            return { result: { projectId: project.id, projectName: project.name } };
          },
        },
      },

      [OPEN_PROJECT_OPERATION_ID]: {
        // prepare: offer git init for non-git directories
        prepare: {
          handler: async (ctx: HookContext): Promise<HookOutput<PrepareHookResult>> => {
            const intent = ctx.intent as OpenProjectIntent;
            const { path, git } = intent.payload;

            // Self-select: only handle local paths
            if (git || !path) return { result: {} };

            // Already open — skip
            if (projects.has(path)) return { result: {} };

            // The contract carries the path as plain data; git operations take a `Path`.
            const pathObj = new Path(path);

            // Check if it's already a git repo
            let isRepo: boolean;
            try {
              isRepo = await gitClient.isRepositoryRoot(pathObj);
            } catch {
              // Path doesn't exist or inaccessible — let resolve handle the error
              return { result: {} };
            }
            if (isRepo) return { result: {} };

            // Not a git repo — ask user
            const dialog = ui.dialog({
              sections: [
                { type: "text", content: "Initialize Git Repository?", style: "heading" },
                { type: "text", content: path.toString(), style: "subtitle" },
                {
                  type: "group",
                  items: [
                    { type: "button", id: "init", label: "Initialize", variant: "primary" },
                    {
                      type: "button",
                      id: "cancel",
                      label: "Cancel",
                      variant: "secondary",
                      role: "cancel",
                    },
                  ],
                },
              ],
            });

            // Escape (dismiss) cancels, same as the Cancel button.
            const event = await dialog.nextEvent();
            dialog.close();

            if (event.kind === "dismiss" || event.actionId !== "init") {
              return { result: { canceled: true } };
            }

            await gitClient.init(pathObj, { initialCommit: "Initial commit" });
            return { result: {} };
          },
        },

        // resolve: validate .git exists for local paths
        resolve: {
          handler: async (ctx: HookContext): Promise<HookOutput<ResolveHookResult>> => {
            const intent = ctx.intent as OpenProjectIntent;
            const { path, git } = intent.payload;

            // Self-select: only handle local paths (not git URLs)
            if (git || !path) {
              return { result: {} };
            }

            // Check persisted config for remoteUrl (restores icon on startup)
            const config = await getProjectConfig(fs, dirs, path);
            const remoteUrl = config?.remoteUrl;

            // Already open — skip validation, signal short-circuit
            if (projects.has(path)) {
              return {
                result: {
                  projectPath: path,
                  alreadyOpen: true,
                  ...(remoteUrl !== undefined && { remoteUrl }),
                },
              };
            }

            await gitWorktreeProvider.validateRepository(new Path(path));

            return {
              result: {
                projectPath: path,
                ...(remoteUrl !== undefined && { remoteUrl }),
              },
            };
          },
        },

        // register: generate ID, persist, add to internal state (all projects)
        register: {
          handler: async (ctx: HookContext): Promise<HookOutput<RegisterHookResult>> => {
            const { projectPath: projectPathStr, remoteUrl } = ctx as RegisterHookInput;

            const projectPath = new Path(projectPathStr);
            const normalizedKey = projectPathSchema.parse(projectPath.toString());
            const projectId = generateProjectId(projectPathStr);

            // Already in state — return alreadyOpen without re-persisting
            if (projects.has(normalizedKey)) {
              return { result: { projectId, name: projectPath.basename, alreadyOpen: true } };
            }

            // Persist to store if new
            const existingConfig = await getProjectConfig(fs, dirs, projectPathStr);
            if (!existingConfig) {
              await saveProject(fs, dirs, projectPathStr, remoteUrl);
            }

            // Add to internal state
            projects.set(normalizedKey, {
              id: projectId,
              name: projectPath.basename,
              path: projectPath,
            });

            return { result: { projectId, name: projectPath.basename } };
          },
        },
      },

      [CLOSE_PROJECT_OPERATION_ID]: {
        // resolve: look up projectPath in config to get remoteUrl
        resolve: {
          handler: async (ctx: HookContext): Promise<HookOutput<CloseResolveHookResult>> => {
            const intent = ctx.intent as CloseProjectIntent;
            const { projectPath } = intent.payload;

            // Look up config to get remoteUrl
            const config = await getProjectConfig(fs, dirs, projectPath);

            return {
              result: {
                ...(config?.remoteUrl !== undefined && { remoteUrl: config.remoteUrl }),
              },
            };
          },
        },

        // close: remove from internal state and config (all projects)
        close: {
          handler: async (ctx: HookContext): Promise<HookOutput<CloseHookResult>> => {
            const { projectPath, removeLocalRepo, remoteUrl } = ctx as CloseHookInput;

            // Remove from internal state
            const normalizedKey = projectPathSchema.parse(new Path(projectPath).toString());
            projects.delete(normalizedKey);

            if (removeLocalRepo && remoteUrl) {
              // Remote project with removeLocalRepo: force-delete its directories —
              // the worktrees' (path-named) and the record's (URL-named).
              const configDirs = new Set([
                projectDirName(projectPath),
                recordDirName(dirs, projectPath, remoteUrl),
              ]);
              for (const dirName of configDirs) {
                try {
                  await fs.rm(nodePath.join(projectsDir, dirName), {
                    recursive: true,
                    force: true,
                  });
                } catch {
                  // Fail silently
                }
              }
            } else {
              // Local project with removeLocalRepo: delete the user's own
              // working copy. The app-data dir still goes through the gentle
              // removal below — a workspaces dir left non-empty by a failed
              // worktree deletion is evidence worth keeping, not something to
              // force-rm away.
              if (removeLocalRepo) {
                await removeLocalDirectory(projectPath);
              }

              // Normal removal: remove config.json and empty dirs
              try {
                await removeProject(fs, dirs, projectPath, remoteUrl);
              } catch {
                // Fail silently
              }
            }

            return { result: { otherProjectsExist: projects.size > 0 } };
          },
        },
      },

      [APP_READY_OPERATION_ID]: {
        // load-projects: load all saved project configs
        "load-projects": {
          handler: async (): Promise<HookOutput<LoadProjectsResult>> => {
            const stored = await loadAllProjects(fs, dirs);
            await migrateLegacyRecords(fs, dirs, stored, logger);
            // A record whose old copy could not be removed is read twice.
            const projectPaths = [...new Set(stored.map((s) => s.config.path))];
            return { result: { projectPaths } };
          },
        },
      },

      // list-projects -> list-projects
      [LIST_PROJECTS_OPERATION_ID]: {
        "list-projects": {
          handler: async (): Promise<HookOutput<ListProjectsHookResult>> => {
            const entries: ListProjectsHookEntry[] = [];
            for (const [key, project] of projects) {
              entries.push({
                projectId: project.id,
                name: project.name,
                path: key,
              });
            }
            return { result: { projects: entries } };
          },
        },
      },
    },
  };
}
