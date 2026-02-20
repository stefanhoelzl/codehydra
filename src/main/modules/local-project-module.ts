/**
 * LocalProjectModule - Sole owner of project state and persistence for ALL projects.
 *
 * Manages internal state (projects map), persists project configs to disk,
 * and responds to resolve-project hook points across all operations.
 *
 * Hook registrations:
 * - project:open  → resolve:  validate .git exists for local paths
 * - project:open  → register: generate ID, persist, add to internal state (all projects)
 * - project:close → resolve-project:  look up projectId in internal state + config
 * - project:close → close:    remove from internal state and config (all projects)
 * - workspace:switch → resolve-project: look up projectId in internal state
 * - app:start     → activate: load ALL saved project configs
 */

import nodePath from "path";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { ProjectId } from "../../shared/api/types";
import { generateProjectId } from "../../shared/api/id-utils";
import { Path } from "../../services/platform/path";
import { projectDirName } from "../../services/platform/paths";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { ProjectConfig } from "../../services/project/types";
import { CURRENT_PROJECT_VERSION } from "../../services/project/types";
import { ProjectStoreError, getErrorMessage } from "../../services/errors";
import type { GitWorktreeProvider } from "../../services/git/git-worktree-provider";
import {
  OPEN_PROJECT_OPERATION_ID,
  type OpenProjectIntent,
  type ResolveHookResult,
  type RegisterHookInput,
  type RegisterHookResult,
} from "../operations/open-project";
import {
  CLOSE_PROJECT_OPERATION_ID,
  type CloseProjectIntent,
  type CloseResolveHookResult,
  type CloseHookInput,
  type CloseHookResult,
} from "../operations/close-project";
import { APP_START_OPERATION_ID, type ActivateHookResult } from "../operations/app-start";
import {
  SWITCH_WORKSPACE_OPERATION_ID,
  type ResolveProjectHookInput as SwitchWorkspaceResolveProjectInput,
  type ResolveProjectHookResult as SwitchWorkspaceResolveProjectResult,
} from "../operations/switch-workspace";
import {
  OPEN_WORKSPACE_OPERATION_ID,
  type OpenWorkspaceIntent,
  type ResolveProjectHookResult as OpenWorkspaceResolveProjectHookResult,
  type ResolveCallerProjectHookInput,
  type ResolveCallerProjectHookResult,
} from "../operations/open-workspace";
import {
  SET_METADATA_OPERATION_ID,
  type ResolveProjectHookInput as SetMetadataResolveProjectInput,
  type ResolveProjectHookResult as SetMetadataResolveProjectResult,
} from "../operations/set-metadata";
import {
  RESTART_AGENT_OPERATION_ID,
  type ResolveProjectHookInput as RestartAgentResolveProjectInput,
  type ResolveProjectHookResult as RestartAgentResolveProjectResult,
} from "../operations/restart-agent";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  type ResolveProjectHookInput as DeleteWorkspaceResolveProjectInput,
  type ResolveProjectHookResult as DeleteWorkspaceResolveProjectResult,
} from "../operations/delete-workspace";
import {
  UPDATE_AGENT_STATUS_OPERATION_ID,
  type ResolveProjectHookInput as UpdateAgentStatusResolveProjectInput,
  type ResolveProjectHookResult as UpdateAgentStatusResolveProjectResult,
} from "../operations/update-agent-status";

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
  readonly fs: Pick<
    FileSystemLayer,
    "readdir" | "readFile" | "writeFile" | "mkdir" | "unlink" | "rm" | "rename"
  >;
  readonly globalProvider: Pick<GitWorktreeProvider, "validateRepository">;
}

// =============================================================================
// Private Persistence Helpers
// =============================================================================

type ProjectFs = LocalProjectModuleDeps["fs"];

async function saveProject(
  fs: ProjectFs,
  projectsDir: string,
  projectPath: string,
  remoteUrl?: string
): Promise<void> {
  const normalizedPath = new Path(projectPath).toString();
  const projectDir = nodePath.join(projectsDir, projectDirName(normalizedPath));
  const configPath = nodePath.join(projectDir, "config.json");

  const config: ProjectConfig = {
    version: CURRENT_PROJECT_VERSION,
    path: normalizedPath,
    ...(remoteUrl !== undefined && { remoteUrl }),
  };

  try {
    await fs.mkdir(projectDir);
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  } catch (error: unknown) {
    throw new ProjectStoreError(`Failed to save project: ${getErrorMessage(error)}`);
  }
}

async function internalLoadAllProjectConfigs(
  fs: ProjectFs,
  projectsDir: string
): Promise<readonly { config: ProjectConfig; entryName: string }[]> {
  const results: { config: ProjectConfig; entryName: string }[] = [];

  try {
    const entries = await fs.readdir(projectsDir);

    for (const entry of entries) {
      if (!entry.isDirectory) {
        continue;
      }

      const configPath = nodePath.join(projectsDir, entry.name, "config.json");

      try {
        const content = await fs.readFile(configPath);
        const parsed: unknown = JSON.parse(content);

        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "path" in parsed &&
          typeof (parsed as Record<string, unknown>).path === "string"
        ) {
          const rawPath = (parsed as { path: string }).path;
          try {
            const normalizedPath = new Path(rawPath).toString();
            const rawRemoteUrl = (parsed as { remoteUrl?: string }).remoteUrl;

            const config: ProjectConfig = {
              version: (parsed as { version?: number }).version ?? 1,
              path: normalizedPath,
              ...(rawRemoteUrl !== undefined && { remoteUrl: rawRemoteUrl }),
            };
            results.push({ config, entryName: entry.name });
          } catch {
            // Invalid path format - skip this entry
            continue;
          }
        }
      } catch {
        // Skip invalid entries (ENOENT, malformed JSON, etc.)
        continue;
      }
    }
  } catch {
    // Directory doesn't exist or other error - return empty array
    return [];
  }

  return results;
}

async function loadAllProjectConfigs(
  fs: ProjectFs,
  projectsDir: string
): Promise<readonly ProjectConfig[]> {
  const internal = await internalLoadAllProjectConfigs(fs, projectsDir);
  return internal.map((entry) => entry.config);
}

async function getProjectConfig(
  fs: ProjectFs,
  projectsDir: string,
  projectPath: string
): Promise<ProjectConfig | undefined> {
  const normalizedPath = new Path(projectPath).toString();

  // First, try the standard path-hashed location (most common case)
  const dirName = projectDirName(normalizedPath);
  const projectDir = nodePath.join(projectsDir, dirName);
  const configPath = nodePath.join(projectDir, "config.json");

  try {
    const content = await fs.readFile(configPath);
    const parsed: unknown = JSON.parse(content);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "path" in parsed &&
      typeof (parsed as Record<string, unknown>).path === "string"
    ) {
      const rawPath = (parsed as { path: string }).path;
      const rawRemoteUrl = (parsed as { remoteUrl?: string }).remoteUrl;

      const config: ProjectConfig = {
        version: (parsed as { version?: number }).version ?? 1,
        path: new Path(rawPath).toString(),
        ...(rawRemoteUrl !== undefined && { remoteUrl: rawRemoteUrl }),
      };
      return config;
    }
  } catch {
    // Config not found in standard location - try scanning all configs
  }

  // Fallback: scan all configs to find one with matching path
  // This handles cloned projects where config is in URL-hashed directory
  const allConfigs = await loadAllProjectConfigs(fs, projectsDir);
  for (const config of allConfigs) {
    if (config.path === normalizedPath) {
      return config;
    }
  }

  return undefined;
}

async function removeProject(
  fs: ProjectFs,
  projectsDir: string,
  projectPath: string
): Promise<void> {
  const dirName = projectDirName(projectPath);
  const projectDir = nodePath.join(projectsDir, dirName);
  const configPath = nodePath.join(projectDir, "config.json");

  try {
    await fs.unlink(configPath);
  } catch {
    // Ignore if file doesn't exist
    return;
  }

  // Try to remove the workspaces subdirectory (only succeeds if empty)
  const workspacesDir = nodePath.join(projectDir, "workspaces");
  try {
    await fs.rm(workspacesDir);
  } catch {
    // ENOTEMPTY (workspaces exist) or ENOENT (doesn't exist) - that's fine
  }

  // Try to remove the project directory (only succeeds if empty)
  try {
    await fs.rm(projectDir);
  } catch {
    // ENOTEMPTY or ENOENT - that's fine
  }
}

// =============================================================================
// Module Factory
// =============================================================================

/**
 * Create a LocalProjectModule that owns project state and persistence for ALL projects.
 *
 * @param deps - FileSystemLayer for persistence, GitWorktreeProvider for .git validation
 * @returns IntentModule with hook handlers for project:open, project:close, app:start
 */
export function createLocalProjectModule(deps: LocalProjectModuleDeps): IntentModule {
  const { projectsDir, fs, globalProvider } = deps;

  /** Internal state: all projects keyed by normalized path string. */
  const projects = new Map<string, LocalProject>();

  /**
   * Shared helper: resolve projectPath → projectId by matching against internal state.
   */
  function resolveProjectIdFromPath(projectPath: string): ProjectId | undefined {
    const normalizedKey = new Path(projectPath).toString();
    for (const project of projects.values()) {
      if (project.path.toString() === normalizedKey) {
        return project.id;
      }
    }
    return undefined;
  }

  return {
    hooks: {
      [OPEN_PROJECT_OPERATION_ID]: {
        // resolve: validate .git exists for local paths
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveHookResult> => {
            const intent = ctx.intent as OpenProjectIntent;
            const { path, git } = intent.payload;

            // Self-select: only handle local paths (not git URLs)
            if (git || !path) {
              return {};
            }

            // Already open — skip validation, signal short-circuit
            if (projects.has(path.toString())) {
              return { projectPath: path.toString(), alreadyOpen: true };
            }

            await globalProvider.validateRepository(path);

            return { projectPath: path.toString() };
          },
        },

        // register: generate ID, persist, add to internal state (all projects)
        register: {
          handler: async (ctx: HookContext): Promise<RegisterHookResult> => {
            const { projectPath: projectPathStr, remoteUrl } = ctx as RegisterHookInput;

            const projectPath = new Path(projectPathStr);
            const normalizedKey = projectPath.toString();
            const projectId = generateProjectId(projectPathStr);

            // Already in state — return alreadyOpen without re-persisting
            if (projects.has(normalizedKey)) {
              return { projectId, name: projectPath.basename, alreadyOpen: true };
            }

            // Persist to store if new
            const existingConfig = await getProjectConfig(fs, projectsDir, projectPathStr);
            if (!existingConfig) {
              await saveProject(fs, projectsDir, projectPathStr, remoteUrl);
            }

            // Add to internal state
            projects.set(normalizedKey, {
              id: projectId,
              name: projectPath.basename,
              path: projectPath,
            });

            return { projectId, name: projectPath.basename };
          },
        },
      },

      [CLOSE_PROJECT_OPERATION_ID]: {
        // resolve-project: look up projectId in internal state + load config for remoteUrl
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<CloseResolveHookResult> => {
            const intent = ctx.intent as CloseProjectIntent;
            const { projectId } = intent.payload;

            // Find project by ID in our state
            for (const project of projects.values()) {
              if (project.id === projectId) {
                const projectPath = project.path.toString();

                // Look up config to get remoteUrl
                const config = await getProjectConfig(fs, projectsDir, projectPath);

                return {
                  projectPath,
                  ...(config?.remoteUrl !== undefined && { remoteUrl: config.remoteUrl }),
                };
              }
            }

            // Not found — return empty
            return {};
          },
        },

        // close: remove from internal state and config (all projects)
        close: {
          handler: async (ctx: HookContext): Promise<CloseHookResult> => {
            const { projectPath, removeLocalRepo, remoteUrl } = ctx as CloseHookInput;

            // Remove from internal state
            const normalizedKey = new Path(projectPath).toString();
            projects.delete(normalizedKey);

            if (removeLocalRepo && remoteUrl) {
              // Remote project with removeLocalRepo: force-delete the config dir
              const configDir = nodePath.join(projectsDir, projectDirName(projectPath));
              try {
                await fs.rm(configDir, { recursive: true, force: true });
              } catch {
                // Fail silently
              }
            } else {
              // Normal removal: remove config.json and empty dirs
              try {
                await removeProject(fs, projectsDir, projectPath);
              } catch {
                // Fail silently
              }
            }

            return { otherProjectsExist: projects.size > 0 };
          },
        },
      },

      [SWITCH_WORKSPACE_OPERATION_ID]: {
        // resolve-project: resolve projectPath → projectId + projectName (for domain events)
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<SwitchWorkspaceResolveProjectResult> => {
            const { projectPath } = ctx as SwitchWorkspaceResolveProjectInput;
            const projectId = resolveProjectIdFromPath(projectPath);
            if (!projectId) return {};

            // Also return projectName from state
            const normalizedKey = new Path(projectPath).toString();
            const project = projects.get(normalizedKey);
            return {
              projectId,
              ...(project ? { projectName: project.name } : {}),
            };
          },
        },
      },

      [APP_START_OPERATION_ID]: {
        // activate: load all saved project configs
        activate: {
          handler: async (): Promise<ActivateHookResult> => {
            const configs = await loadAllProjectConfigs(fs, projectsDir);
            return { projectPaths: configs.map((c) => c.path) };
          },
        },
      },

      [SET_METADATA_OPERATION_ID]: {
        // resolve-project: resolve projectPath → projectId (for domain events)
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<SetMetadataResolveProjectResult> => {
            const { projectPath } = ctx as SetMetadataResolveProjectInput;
            const projectId = resolveProjectIdFromPath(projectPath);
            return projectId ? { projectId } : {};
          },
        },
      },

      [RESTART_AGENT_OPERATION_ID]: {
        // resolve-project: resolve projectPath → projectId (for domain events)
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<RestartAgentResolveProjectResult> => {
            const { projectPath } = ctx as RestartAgentResolveProjectInput;
            const projectId = resolveProjectIdFromPath(projectPath);
            return projectId ? { projectId } : {};
          },
        },
      },

      [OPEN_WORKSPACE_OPERATION_ID]: {
        // resolve-project: resolve projectId to path from project state (sole handler)
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<OpenWorkspaceResolveProjectHookResult> => {
            const intent = ctx.intent as OpenWorkspaceIntent;
            const { projectId, projectPath: payloadPath } = intent.payload;

            // Short-circuit: authoritative path already provided
            if (payloadPath) {
              return { projectPath: payloadPath };
            }

            // Look up projectId in project state
            if (!projectId) return {};
            for (const project of projects.values()) {
              if (project.id === projectId) {
                return { projectPath: project.path.toString() };
              }
            }

            return {};
          },
        },
        // resolve-caller-project: resolve projectPath → projectId (for callerWorkspacePath flow)
        "resolve-caller-project": {
          handler: async (ctx: HookContext): Promise<ResolveCallerProjectHookResult> => {
            const { projectPath } = ctx as ResolveCallerProjectHookInput;
            const projectId = resolveProjectIdFromPath(projectPath);
            return projectId ? { projectId } : {};
          },
        },
      },

      [DELETE_WORKSPACE_OPERATION_ID]: {
        // resolve-project: resolve projectPath → projectId (for domain events)
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<DeleteWorkspaceResolveProjectResult> => {
            const { projectPath } = ctx as DeleteWorkspaceResolveProjectInput;
            const projectId = resolveProjectIdFromPath(projectPath);
            return projectId ? { projectId } : {};
          },
        },
      },

      [UPDATE_AGENT_STATUS_OPERATION_ID]: {
        "resolve-project": {
          handler: async (ctx: HookContext): Promise<UpdateAgentStatusResolveProjectResult> => {
            const { projectPath } = ctx as UpdateAgentStatusResolveProjectInput;
            const projectId = resolveProjectIdFromPath(projectPath);
            return projectId ? { projectId } : {};
          },
        },
      },
    },
  };
}
