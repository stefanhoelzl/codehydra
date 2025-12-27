/**
 * Application state management.
 * Manages open projects, workspace providers, and coordinates with ViewManager.
 */

import path from "node:path";
import {
  createGitWorktreeProvider,
  KeepFilesService,
  type IWorkspaceProvider,
  type PathProvider,
  type ProjectStore,
  type Workspace,
  type FileSystemLayer,
  type LoggingService,
  type Logger,
  urlForFolder,
} from "../services";
import type { IViewManager } from "./managers/view-manager.interface";
import type { Project, ProjectPath, WorkspacePath } from "../shared/ipc";
import type { AgentStatusManager } from "../services/opencode/agent-status-manager";
import type { OpenCodeServerManager } from "../services/opencode/opencode-server-manager";

/**
 * Runtime state for an open project.
 */
interface OpenProject {
  /** Project metadata */
  readonly project: Project;
  /** Workspace provider for git operations */
  readonly provider: IWorkspaceProvider;
}

/**
 * Manages application state including open projects and workspace providers.
 */
export class AppState {
  private readonly projectStore: ProjectStore;
  private readonly viewManager: IViewManager;
  private readonly pathProvider: PathProvider;
  private readonly codeServerPort: number;
  private readonly fileSystemLayer: FileSystemLayer;
  private readonly loggingService: LoggingService;
  private readonly logger: Logger;
  private readonly openProjects: Map<string, OpenProject> = new Map();
  private readonly lastBaseBranches: Map<string, string> = new Map();
  private agentStatusManager: AgentStatusManager | null = null;
  private serverManager: OpenCodeServerManager | null = null;

  constructor(
    projectStore: ProjectStore,
    viewManager: IViewManager,
    pathProvider: PathProvider,
    codeServerPort: number,
    fileSystemLayer: FileSystemLayer,
    loggingService: LoggingService
  ) {
    this.projectStore = projectStore;
    this.viewManager = viewManager;
    this.pathProvider = pathProvider;
    this.codeServerPort = codeServerPort;
    this.fileSystemLayer = fileSystemLayer;
    this.loggingService = loggingService;
    this.logger = loggingService.createLogger("app");
  }

  /**
   * Set the agent status manager (injected from main process).
   */
  setAgentStatusManager(manager: AgentStatusManager): void {
    this.agentStatusManager = manager;
  }

  /**
   * Get the agent status manager.
   */
  getAgentStatusManager(): AgentStatusManager | null {
    return this.agentStatusManager;
  }

  /**
   * Set the OpenCode server manager and wire callbacks.
   * Called from main process after creating services.
   */
  setServerManager(manager: OpenCodeServerManager): void {
    this.serverManager = manager;

    // Wire server callbacks to agent status manager
    manager.onServerStarted((workspacePath, port) => {
      if (this.agentStatusManager) {
        void this.agentStatusManager.initWorkspace(workspacePath as WorkspacePath, port);
      }
    });

    manager.onServerStopped((workspacePath) => {
      if (this.agentStatusManager) {
        this.agentStatusManager.removeWorkspace(workspacePath as WorkspacePath);
      }
    });
  }

  /**
   * Get the OpenCode server manager.
   */
  getServerManager(): OpenCodeServerManager | null {
    return this.serverManager;
  }

  /**
   * Sets the last used base branch for a project.
   * This is used to remember the user's branch selection within a session.
   *
   * @param projectPath - Path to the project
   * @param branch - Branch name that was used
   */
  setLastBaseBranch(projectPath: string, branch: string): void {
    this.lastBaseBranches.set(projectPath, branch);
  }

  /**
   * Gets the default base branch for a project.
   * Returns the last used branch if set, otherwise falls back to provider's defaultBase().
   *
   * @param projectPath - Path to the project
   * @returns The default branch name, or undefined if not determinable
   */
  async getDefaultBaseBranch(projectPath: string): Promise<string | undefined> {
    // Check runtime cache first
    const lastBranch = this.lastBaseBranches.get(projectPath);
    if (lastBranch) {
      return lastBranch;
    }

    // Fall back to provider's default
    const provider = this.getWorkspaceProvider(projectPath);
    if (!provider) {
      return undefined;
    }

    try {
      return await provider.defaultBase();
    } catch (error: unknown) {
      this.logger.warn("Failed to get default base branch", {
        projectPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Opens a project by path.
   * Validates it's a git repository, discovers workspaces, creates views.
   *
   * @param projectPath - Absolute path to the project (git repository)
   * @returns The opened Project
   * @throws WorkspaceError if path is not a valid git repository
   */
  async openProject(projectPath: string): Promise<Project> {
    // Create workspace provider (validates it's a git repo)
    const workspacesDir = this.pathProvider.getProjectWorkspacesDir(projectPath);
    const keepFilesService = new KeepFilesService(
      this.fileSystemLayer,
      this.loggingService.createLogger("keepfiles")
    );
    const provider = await createGitWorktreeProvider(
      projectPath,
      workspacesDir,
      this.fileSystemLayer,
      this.loggingService.createLogger("git"),
      this.loggingService.createLogger("worktree"),
      { keepFilesService }
    );

    // Run cleanup non-blocking (fire and forget)
    if (provider.cleanupOrphanedWorkspaces) {
      void provider.cleanupOrphanedWorkspaces().catch((err: unknown) => {
        this.logger.error(
          "Workspace cleanup failed",
          { projectPath },
          err instanceof Error ? err : undefined
        );
      });
    }

    // Discover existing workspaces (excludes main directory)
    const workspaces = await provider.discover();

    // Create views for each workspace and start OpenCode servers
    for (const workspace of workspaces) {
      const url = this.getWorkspaceUrl(workspace.path);
      this.viewManager.createWorkspaceView(workspace.path, url, projectPath);

      // Start OpenCode server for the workspace (agent status tracking is wired via callback)
      if (this.serverManager) {
        void this.serverManager.startServer(workspace.path).catch((err: unknown) => {
          this.logger.error(
            "Failed to start OpenCode server",
            { workspacePath: workspace.path },
            err instanceof Error ? err : undefined
          );
        });
      }
    }

    // Set first workspace as active, or null if none
    const firstWorkspace = workspaces[0];
    this.viewManager.setActiveWorkspace(firstWorkspace?.path ?? null);

    // Store in internal state first (needed for getDefaultBaseBranch to work)
    this.openProjects.set(projectPath, {
      project: {
        path: projectPath as ProjectPath,
        name: path.basename(projectPath),
        workspaces,
      },
      provider,
    });

    // Get default base branch (uses lastBaseBranches cache or provider fallback)
    const defaultBaseBranch = await this.getDefaultBaseBranch(projectPath);

    // Create final project object with defaultBaseBranch (only include if defined)
    const project: Project = {
      path: projectPath as ProjectPath,
      name: path.basename(projectPath),
      workspaces,
      ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
    };

    // Update stored project with defaultBaseBranch
    this.openProjects.set(projectPath, { project, provider });

    // Persist to store
    await this.projectStore.saveProject(projectPath);

    return project;
  }

  /**
   * Closes a project.
   * Destroys all workspace views, cleans up state, and removes from persistent storage.
   *
   * @param projectPath - Path to the project to close
   */
  async closeProject(projectPath: string): Promise<void> {
    const openProject = this.openProjects.get(projectPath);
    if (!openProject) {
      return;
    }

    // Stop all OpenCode servers for this project
    if (this.serverManager) {
      await this.serverManager.stopAllForProject(projectPath);
    }

    // Destroy all workspace views
    for (const workspace of openProject.project.workspaces) {
      await this.viewManager.destroyWorkspaceView(workspace.path);
    }

    // Remove from state
    this.openProjects.delete(projectPath);

    // Remove from persistent storage (fail silently)
    try {
      await this.projectStore.removeProject(projectPath);
    } catch {
      // Fail silently as per requirements
    }
  }

  /**
   * Gets a project by path.
   *
   * @param projectPath - Path to the project
   * @returns The Project or undefined if not open
   */
  getProject(projectPath: string): Project | undefined {
    return this.openProjects.get(projectPath)?.project;
  }

  /**
   * Gets all open projects with current defaultBaseBranch.
   *
   * @returns Promise resolving to array of all open projects
   */
  async getAllProjects(): Promise<Project[]> {
    const result: Project[] = [];
    for (const openProject of this.openProjects.values()) {
      const defaultBaseBranch = await this.getDefaultBaseBranch(openProject.project.path);
      result.push({
        ...openProject.project,
        ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
      });
    }
    return result;
  }

  /**
   * Gets the workspace provider for a project.
   *
   * @param projectPath - Path to the project
   * @returns The IWorkspaceProvider or undefined if project not open
   */
  getWorkspaceProvider(projectPath: string): IWorkspaceProvider | undefined {
    return this.openProjects.get(projectPath)?.provider;
  }

  /**
   * Generates a code-server URL for a workspace.
   *
   * @param workspacePath - Absolute path to the workspace directory
   * @returns The code-server URL
   */
  getWorkspaceUrl(workspacePath: string): string {
    return urlForFolder(this.codeServerPort, workspacePath);
  }

  /**
   * Loads persisted projects at startup.
   * Skips projects that are no longer valid git repositories.
   */
  async loadPersistedProjects(): Promise<void> {
    const projectPaths = await this.projectStore.loadAllProjects();

    for (const projectPath of projectPaths) {
      try {
        await this.openProject(projectPath);
      } catch {
        // Skip invalid projects (no longer exist, not git repos, etc.)
        // Optionally could delete from store here
      }
    }
  }

  /**
   * Finds the project that contains a workspace.
   *
   * @param workspacePath - Path to the workspace
   * @returns The Project containing the workspace, or undefined
   */
  findProjectForWorkspace(workspacePath: string): Project | undefined {
    // Normalize the input path for comparison:
    // - Use path.normalize to handle forward/backslashes
    // - On Windows, use case-insensitive comparison (filesystem is case-insensitive)
    // - On Linux/macOS, use case-sensitive comparison (filesystem is case-sensitive)
    const isWindows = process.platform === "win32";
    const normalizePath = (p: string) => {
      const normalized = path.normalize(p);
      return isWindows ? normalized.toLowerCase() : normalized;
    };

    const normalizedInput = normalizePath(workspacePath);

    for (const openProject of this.openProjects.values()) {
      const found = openProject.project.workspaces.find(
        (w) => normalizePath(w.path) === normalizedInput
      );
      if (found) {
        return openProject.project;
      }
    }
    return undefined;
  }

  /**
   * Adds a workspace to an open project.
   * Creates a view and updates the project state.
   *
   * @param projectPath - Path to the project
   * @param workspace - The workspace to add
   */
  addWorkspace(projectPath: string, workspace: Workspace): void {
    const openProject = this.openProjects.get(projectPath);
    if (!openProject) {
      return;
    }

    // Create view for the workspace
    const url = this.getWorkspaceUrl(workspace.path);
    this.viewManager.createWorkspaceView(workspace.path, url, projectPath);

    // Update project state
    const updatedProject: Project = {
      ...openProject.project,
      workspaces: [...openProject.project.workspaces, workspace],
    };

    this.openProjects.set(projectPath, {
      ...openProject,
      project: updatedProject,
    });

    // Start OpenCode server for the workspace (agent status tracking is wired via callback)
    if (this.serverManager) {
      void this.serverManager.startServer(workspace.path).catch((err: unknown) => {
        this.logger.error(
          "Failed to start OpenCode server",
          { workspacePath: workspace.path },
          err instanceof Error ? err : undefined
        );
      });
    }
  }

  /**
   * Removes a workspace from an open project.
   * Destroys the view and updates the project state.
   *
   * @param projectPath - Path to the project
   * @param workspacePath - Path to the workspace to remove
   */
  async removeWorkspace(projectPath: string, workspacePath: string): Promise<void> {
    const openProject = this.openProjects.get(projectPath);
    if (!openProject) {
      return;
    }

    // Stop OpenCode server (this will trigger onServerStopped callback, which removes agent status)
    if (this.serverManager) {
      await this.serverManager.stopServer(workspacePath);
    }

    // Destroy the workspace view
    await this.viewManager.destroyWorkspaceView(workspacePath);

    // Update project state
    const updatedProject: Project = {
      ...openProject.project,
      workspaces: openProject.project.workspaces.filter((w) => w.path !== workspacePath),
    };

    this.openProjects.set(projectPath, {
      ...openProject,
      project: updatedProject,
    });
  }
}
