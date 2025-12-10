/**
 * Application state management.
 * Manages open projects, workspace providers, and coordinates with ViewManager.
 */

import path from "node:path";
import {
  createGitWorktreeProvider,
  type IWorkspaceProvider,
  type PathProvider,
  type ProjectStore,
  type Workspace,
  urlForFolder,
} from "../services";
import type { IViewManager } from "./managers/view-manager.interface";
import type { Project, ProjectPath, WorkspacePath } from "../shared/ipc";
import type { AgentStatusManager } from "../services/opencode/agent-status-manager";
import type { DiscoveryService } from "../services/opencode/discovery-service";

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
  private readonly openProjects: Map<string, OpenProject> = new Map();
  private discoveryService: DiscoveryService | null = null;
  private agentStatusManager: AgentStatusManager | null = null;

  constructor(
    projectStore: ProjectStore,
    viewManager: IViewManager,
    pathProvider: PathProvider,
    codeServerPort: number
  ) {
    this.projectStore = projectStore;
    this.viewManager = viewManager;
    this.pathProvider = pathProvider;
    this.codeServerPort = codeServerPort;
  }

  /**
   * Set the discovery service (injected from main process).
   */
  setDiscoveryService(service: DiscoveryService): void {
    this.discoveryService = service;
  }

  /**
   * Get the discovery service.
   */
  getDiscoveryService(): DiscoveryService | null {
    return this.discoveryService;
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
    const provider = await createGitWorktreeProvider(projectPath, workspacesDir);

    // Discover existing workspaces (excludes main directory)
    const workspaces = await provider.discover();

    // Create views for each workspace and initialize agent status tracking
    for (const workspace of workspaces) {
      const url = this.getWorkspaceUrl(workspace.path);
      this.viewManager.createWorkspaceView(workspace.path, url);

      // Initialize agent status tracking for the workspace
      if (this.agentStatusManager) {
        void this.agentStatusManager.initWorkspace(workspace.path as WorkspacePath);
      }
    }

    // Set first workspace as active, or null if none
    const firstWorkspace = workspaces[0];
    this.viewManager.setActiveWorkspace(firstWorkspace?.path ?? null);

    // Create project object
    const project: Project = {
      path: projectPath as ProjectPath,
      name: path.basename(projectPath),
      workspaces,
    };

    // Store in internal state
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

    // Destroy all workspace views
    for (const workspace of openProject.project.workspaces) {
      this.viewManager.destroyWorkspaceView(workspace.path);
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
   * Gets all open projects.
   *
   * @returns Array of all open projects
   */
  getAllProjects(): Project[] {
    return Array.from(this.openProjects.values()).map((p) => p.project);
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
    for (const openProject of this.openProjects.values()) {
      const found = openProject.project.workspaces.find((w) => w.path === workspacePath);
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
    this.viewManager.createWorkspaceView(workspace.path, url);

    // Update project state
    const updatedProject: Project = {
      ...openProject.project,
      workspaces: [...openProject.project.workspaces, workspace],
    };

    this.openProjects.set(projectPath, {
      ...openProject,
      project: updatedProject,
    });

    // Initialize agent status tracking for the workspace
    if (this.agentStatusManager) {
      void this.agentStatusManager.initWorkspace(workspace.path as WorkspacePath);
    }
  }

  /**
   * Removes a workspace from an open project.
   * Destroys the view and updates the project state.
   *
   * @param projectPath - Path to the project
   * @param workspacePath - Path to the workspace to remove
   */
  removeWorkspace(projectPath: string, workspacePath: string): void {
    const openProject = this.openProjects.get(projectPath);
    if (!openProject) {
      return;
    }

    // Destroy the workspace view
    this.viewManager.destroyWorkspaceView(workspacePath);

    // Update project state
    const updatedProject: Project = {
      ...openProject.project,
      workspaces: openProject.project.workspaces.filter((w) => w.path !== workspacePath),
    };

    this.openProjects.set(projectPath, {
      ...openProject,
      project: updatedProject,
    });

    // Remove agent status tracking for the workspace
    if (this.agentStatusManager) {
      this.agentStatusManager.removeWorkspace(workspacePath as WorkspacePath);
    }
  }
}
