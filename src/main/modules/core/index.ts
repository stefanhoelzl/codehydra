/**
 * CoreModule - Handles project, workspace, and UI operations.
 *
 * Responsibilities:
 * - Project operations: open, close, list, get, fetchBases
 * - Workspace operations: get, executeCommand
 * - UI operations: selectFolder, switchWorkspace
 *
 * Note: workspace create and remove are handled by the intent dispatcher.
 *
 * Created in startServices() after setup is complete.
 */

import type {
  IApiRegistry,
  IApiModule,
  ProjectOpenPayload,
  ProjectClosePayload,
  ProjectClonePayload,
  ProjectIdPayload,
  WorkspaceRefPayload,
  WorkspaceExecuteCommandPayload,
  UiSwitchWorkspacePayload,
  EmptyPayload,
} from "../../api/registry-types";
import type { PluginResult } from "../../../shared/plugin-protocol";
import type { ProjectId, Project, Workspace, BaseInfo } from "../../../shared/api/types";
import type { AppState } from "../../app-state";
import type { IViewManager } from "../../managers/view-manager.interface";
import type { Logger } from "../../../services/logging/index";
import { ApiIpcChannels } from "../../../shared/ipc";
import { SILENT_LOGGER } from "../../../services/logging";
import {
  generateProjectId,
  extractWorkspaceName,
  resolveProjectPath,
  resolveWorkspace as resolveWorkspaceShared,
  tryResolveWorkspace as tryResolveWorkspaceShared,
  type InternalResolvedWorkspace,
} from "../../api/id-utils";
import { Path, type IGitClient, type PathProvider, type ProjectStore } from "../../../services";
import {
  isValidGitUrl,
  generateProjectIdFromUrl,
  extractRepoName,
  expandGitUrl,
} from "../../../services/project/url-utils";

// =============================================================================
// Types
// =============================================================================

/**
 * Minimal interface for PluginServer's sendCommand method.
 * Used for dependency injection to execute VS Code commands in workspaces.
 */
export interface IPluginServer {
  sendCommand(
    workspacePath: string,
    command: string,
    args?: readonly unknown[]
  ): Promise<PluginResult<unknown>>;
}

/**
 * Minimal dialog interface required for folder selection.
 */
export interface MinimalDialog {
  showOpenDialog(options: { properties: string[] }): Promise<{
    canceled: boolean;
    filePaths: string[];
  }>;
}

/**
 * Dependencies for CoreModule.
 */
export interface CoreModuleDeps {
  /** Application state manager */
  readonly appState: AppState;
  /** View manager for workspace views */
  readonly viewManager: IViewManager;
  /** Git client for clone operations */
  readonly gitClient: IGitClient;
  /** Path provider for determining clone target directory */
  readonly pathProvider: PathProvider;
  /** Project store for finding existing cloned projects */
  readonly projectStore: ProjectStore;
  /** Plugin server for executing VS Code commands in workspaces */
  readonly pluginServer?: IPluginServer;
  /** Electron dialog for folder selection */
  readonly dialog?: MinimalDialog;
  /** Optional logger */
  readonly logger?: Logger;
}

// =============================================================================
// Module Implementation
// =============================================================================

/**
 * CoreModule handles project and workspace operations.
 *
 * Registered methods:
 * - projects.*: open, close, list, get, fetchBases
 * - workspaces.*: get, executeCommand
 * - ui.selectFolder, ui.switchWorkspace
 *
 * Note: workspaces.create and workspaces.remove are handled by the intent dispatcher.
 *
 * Events emitted:
 * - project:opened, project:closed, project:bases-updated
 * - workspace:switched
 */
export class CoreModule implements IApiModule {
  private readonly logger: Logger;

  /**
   * Create a new CoreModule.
   *
   * @param api The API registry to register methods on
   * @param deps Module dependencies
   */
  constructor(
    private readonly api: IApiRegistry,
    private readonly deps: CoreModuleDeps
  ) {
    this.logger = deps.logger ?? SILENT_LOGGER;
    this.registerMethods();
  }

  /**
   * Register all project and workspace methods with the API registry.
   */
  private registerMethods(): void {
    // Project methods
    this.api.register("projects.open", this.projectOpen.bind(this), {
      ipc: ApiIpcChannels.PROJECT_OPEN,
    });
    this.api.register("projects.close", this.projectClose.bind(this), {
      ipc: ApiIpcChannels.PROJECT_CLOSE,
    });
    this.api.register("projects.clone", this.projectClone.bind(this), {
      ipc: ApiIpcChannels.PROJECT_CLONE,
    });
    this.api.register("projects.list", this.projectList.bind(this), {
      ipc: ApiIpcChannels.PROJECT_LIST,
    });
    this.api.register("projects.get", this.projectGet.bind(this), {
      ipc: ApiIpcChannels.PROJECT_GET,
    });
    this.api.register("projects.fetchBases", this.projectFetchBases.bind(this), {
      ipc: ApiIpcChannels.PROJECT_FETCH_BASES,
    });

    // Workspace methods (workspaces.create and workspaces.remove handled by intent dispatcher in bootstrap.ts)
    this.api.register("workspaces.get", this.workspaceGet.bind(this), {
      ipc: ApiIpcChannels.WORKSPACE_GET,
    });
    // executeCommand is not exposed via IPC (only used by MCP/Plugin)
    this.api.register("workspaces.executeCommand", this.workspaceExecuteCommand.bind(this));

    // UI methods (relocated from UiModule)
    this.api.register("ui.selectFolder", this.selectFolder.bind(this), {
      ipc: ApiIpcChannels.UI_SELECT_FOLDER,
    });
    this.api.register("ui.switchWorkspace", this.switchWorkspace.bind(this), {
      ipc: ApiIpcChannels.UI_SWITCH_WORKSPACE,
    });
  }

  // ===========================================================================
  // Project Methods
  // ===========================================================================

  private async projectOpen(payload: ProjectOpenPayload): Promise<Project> {
    const internalProject = await this.deps.appState.openProject(payload.path);
    const apiProject = this.toApiProject(internalProject, internalProject.defaultBaseBranch);

    this.api.emit("project:opened", { project: apiProject });

    return apiProject;
  }

  private async projectClose(payload: ProjectClosePayload): Promise<void> {
    const projectPath = await resolveProjectPath(payload.projectId, this.deps.appState);
    if (!projectPath) {
      throw new Error(`Project not found: ${payload.projectId}`);
    }

    // Get project config BEFORE closing (closeProject removes the config)
    // We need this to determine if it's a cloned project for removeLocalRepo
    const projectConfig = payload.removeLocalRepo
      ? await this.deps.projectStore.getProjectConfig(projectPath)
      : undefined;

    // Close the project (stops servers, destroys views, removes from state and config)
    await this.deps.appState.closeProject(projectPath);

    // If removeLocalRepo is requested, delete the entire project directory
    if (payload.removeLocalRepo) {
      if (projectConfig?.remoteUrl) {
        this.logger.debug("Deleting cloned project directory", { projectPath });
        // Pass isClonedProject since config was already removed by closeProject
        await this.deps.projectStore.deleteProjectDirectory(projectPath, { isClonedProject: true });
      } else {
        this.logger.warn("removeLocalRepo requested but project has no remoteUrl", { projectPath });
      }
    }

    this.api.emit("project:closed", { projectId: payload.projectId });
  }

  private async projectClone(payload: ProjectClonePayload): Promise<Project> {
    // Expand shorthand URLs (e.g., "org/repo" -> "https://github.com/org/repo.git")
    const url = expandGitUrl(payload.url);

    // Validate URL format
    if (!isValidGitUrl(url)) {
      throw new Error(`Invalid git URL: ${payload.url}`);
    }

    // Check if we already have a project from this URL
    const existingPath = await this.deps.projectStore.findByRemoteUrl(url);
    if (existingPath) {
      this.logger.debug("Found existing project for URL", { url, existingPath });

      // Check if project is already open
      const existingProject = this.deps.appState.getProject(existingPath);
      if (existingProject) {
        return this.toApiProject(existingProject, existingProject.defaultBaseBranch);
      }

      // Project exists but not open - open it
      return this.projectOpen({ path: existingPath });
    }

    // Determine target path
    const projectId = generateProjectIdFromUrl(url);
    const repoName = extractRepoName(url);
    const projectsDirPath = this.deps.pathProvider.projectsDir;
    // Use project ID as subdirectory name to avoid collisions
    // e.g., /projects/my-repo-abcd1234
    const projectPath = new Path(projectsDirPath, projectId);
    // Bare clone goes to repo-name subdirectory (name derived from URL)
    // e.g., /projects/my-repo-abcd1234/my-repo
    const gitPath = new Path(projectPath.toString(), repoName);

    this.logger.debug("Cloning repository", { url, gitPath: gitPath.toString() });

    // Clone using GitClient (bare clone to git/ subdirectory)
    await this.deps.gitClient.clone(url, gitPath);

    // Save to project store with remoteUrl (config at project level, not git subdirectory)
    // Use configDir to store config inside the URL-hashed directory we created,
    // not a separate path-hashed directory. This ensures findByRemoteUrl can locate the project.
    await this.deps.projectStore.saveProject(gitPath.toString(), {
      remoteUrl: url,
      configDir: projectId,
    });

    // Open the newly cloned project (at git/ subdirectory where the repo is)
    const project = await this.deps.appState.openProject(gitPath.toString());

    const apiProject = this.toApiProject(project, project.defaultBaseBranch);

    this.api.emit("project:opened", { project: apiProject });

    return apiProject;
  }

  private async projectList(payload: EmptyPayload): Promise<readonly Project[]> {
    void payload; // Required by MethodHandler interface but unused for no-arg methods
    const internalProjects = await this.deps.appState.getAllProjects();
    return internalProjects.map((p) => this.toApiProject(p, p.defaultBaseBranch));
  }

  private async projectGet(payload: ProjectIdPayload): Promise<Project | undefined> {
    const projectPath = await resolveProjectPath(payload.projectId, this.deps.appState);
    if (!projectPath) return undefined;

    const internalProject = this.deps.appState.getProject(projectPath);
    if (!internalProject) return undefined;

    const defaultBaseBranch = await this.deps.appState.getDefaultBaseBranch(projectPath);
    return this.toApiProject(internalProject, defaultBaseBranch);
  }

  private async projectFetchBases(
    payload: ProjectIdPayload
  ): Promise<{ readonly bases: readonly BaseInfo[] }> {
    const projectPath = await resolveProjectPath(payload.projectId, this.deps.appState);
    if (!projectPath) {
      throw new Error(`Project not found: ${payload.projectId}`);
    }

    const provider = this.deps.appState.getWorkspaceProvider(projectPath);
    if (!provider) {
      throw new Error(`No workspace provider for project: ${payload.projectId}`);
    }

    // Get current bases (cached)
    const bases = await provider.listBases();

    // Trigger background fetch - don't await
    void this.fetchBasesInBackground(payload.projectId, provider);

    return { bases };
  }

  // ===========================================================================
  // Workspace Methods
  // ===========================================================================

  private async workspaceGet(payload: WorkspaceRefPayload): Promise<Workspace | undefined> {
    const resolved = await this.tryResolveWorkspace(payload);
    if (!resolved) return undefined;

    return this.toApiWorkspace(payload.projectId, resolved.workspace);
  }

  private async workspaceExecuteCommand(payload: WorkspaceExecuteCommandPayload): Promise<unknown> {
    const { workspace } = await this.resolveWorkspace(payload);

    if (!this.deps.pluginServer) {
      throw new Error("Plugin server not available");
    }

    const result = await this.deps.pluginServer.sendCommand(
      workspace.path,
      payload.command,
      payload.args
    );

    if (!result.success) {
      throw new Error(result.error);
    }

    return result.data;
  }

  // ===========================================================================
  // UI Methods (relocated from UiModule)
  // ===========================================================================

  private async selectFolder(payload: EmptyPayload): Promise<string | null> {
    void payload; // Required by MethodHandler interface but unused for no-arg methods
    if (!this.deps.dialog) {
      throw new Error("Dialog not available");
    }
    const result = await this.deps.dialog.showOpenDialog({
      properties: ["openDirectory"],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0] ?? null;
  }

  private async switchWorkspace(payload: UiSwitchWorkspacePayload): Promise<void> {
    const { workspace } = await this.resolveWorkspace(payload);

    const focus = payload.focus ?? true;
    // Note: workspace:switched event is emitted via ViewManager.onWorkspaceChange callback
    // wired in index.ts, not directly here
    this.deps.viewManager.setActiveWorkspace(workspace.path, focus);
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  private toApiProject(
    internalProject: {
      path: string;
      name: string;
      remoteUrl?: string;
      workspaces: ReadonlyArray<{
        path: string;
        branch?: string | null;
        metadata: Readonly<Record<string, string>>;
      }>;
    },
    defaultBaseBranch?: string
  ): Project {
    const projectId = generateProjectId(internalProject.path);
    return {
      id: projectId,
      name: internalProject.name,
      path: internalProject.path,
      workspaces: internalProject.workspaces.map((w) => this.toApiWorkspace(projectId, w)),
      ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
      ...(internalProject.remoteUrl !== undefined && { remoteUrl: internalProject.remoteUrl }),
    };
  }

  private toApiWorkspace(
    projectId: ProjectId,
    internalWorkspace: {
      path: string;
      branch?: string | null;
      metadata: Readonly<Record<string, string>>;
    }
  ): Workspace {
    const name = extractWorkspaceName(internalWorkspace.path);
    return {
      projectId,
      name,
      branch: internalWorkspace.branch ?? null,
      metadata: internalWorkspace.metadata,
      path: internalWorkspace.path,
    };
  }

  /**
   * Resolve a workspace from payload, throwing on not found.
   * Uses shared utility from id-utils.
   */
  private resolveWorkspace(payload: WorkspaceRefPayload): Promise<InternalResolvedWorkspace> {
    return resolveWorkspaceShared(payload, this.deps.appState);
  }

  /**
   * Try to resolve a workspace from payload, returning undefined on not found.
   * Uses shared utility from id-utils.
   */
  private tryResolveWorkspace(
    payload: WorkspaceRefPayload
  ): Promise<InternalResolvedWorkspace | undefined> {
    return tryResolveWorkspaceShared(payload, this.deps.appState);
  }

  private async fetchBasesInBackground(
    projectId: ProjectId,
    provider: { updateBases(): Promise<unknown>; listBases(): Promise<readonly BaseInfo[]> }
  ): Promise<void> {
    try {
      await provider.updateBases();
      const updatedBases = await provider.listBases();
      this.api.emit("project:bases-updated", { projectId, bases: updatedBases });
    } catch (error) {
      this.logger.error(
        "Failed to fetch bases for project",
        { projectId },
        error instanceof Error ? error : undefined
      );
    }
  }

  // ===========================================================================
  // IApiModule Implementation
  // ===========================================================================

  dispose(): void {
    // No resources to dispose (IPC handlers cleaned up by ApiRegistry)
  }
}
