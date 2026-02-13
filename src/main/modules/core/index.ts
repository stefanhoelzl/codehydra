/**
 * CoreModule - Handles read-only project queries, workspace queries, and UI operations.
 *
 * Responsibilities:
 * - Project queries: list, get, fetchBases
 * - Workspace operations: get, executeCommand
 * - UI operations: selectFolder
 *
 * Note: workspace create/remove, project open/close/clone, and ui.switchWorkspace
 * are handled by the intent dispatcher.
 *
 * Created in startServices() after setup is complete.
 */

import type {
  IApiRegistry,
  IApiModule,
  ProjectIdPayload,
  WorkspaceRefPayload,
  WorkspaceExecuteCommandPayload,
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
import type { IGitClient, PathProvider, ProjectStore } from "../../../services";
import type { GitWorktreeProvider } from "../../../services/git/git-worktree-provider";
import { Path } from "../../../services/platform/path";

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
  /** Global worktree provider for git operations */
  readonly globalProvider: GitWorktreeProvider;
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
 * CoreModule handles read-only project queries, workspace queries, and UI operations.
 *
 * Registered methods:
 * - projects.*: list, get, fetchBases
 * - workspaces.*: get, executeCommand
 * - ui.selectFolder
 *
 * Note: workspaces.create/remove, projects.open/close/clone, and ui.switchWorkspace
 * are handled by the intent dispatcher.
 *
 * Events emitted:
 * - project:bases-updated
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
   * Register all project query, workspace, and UI methods with the API registry.
   * Note: projects.open/close/clone are registered by the intent dispatcher in bootstrap.ts.
   */
  private registerMethods(): void {
    // Project query methods (open/close/clone handled by intent dispatcher in bootstrap.ts)
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
    // Note: ui.switchWorkspace is handled by the intent dispatcher in bootstrap.ts
    this.api.register("ui.selectFolder", this.selectFolder.bind(this), {
      ipc: ApiIpcChannels.UI_SELECT_FOLDER,
    });
  }

  // ===========================================================================
  // Project Query Methods
  // ===========================================================================

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

    const projectRoot = new Path(projectPath);

    // Get current bases (cached)
    const bases = await this.deps.globalProvider.listBases(projectRoot);

    // Trigger background fetch - don't await
    void this.fetchBasesInBackground(payload.projectId, projectRoot);

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

  private async fetchBasesInBackground(projectId: ProjectId, projectRoot: Path): Promise<void> {
    try {
      await this.deps.globalProvider.updateBases(projectRoot);
      const updatedBases = await this.deps.globalProvider.listBases(projectRoot);
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
