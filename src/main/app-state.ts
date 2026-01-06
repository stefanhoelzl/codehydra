/**
 * Application state management.
 * Manages open projects, workspace providers, and coordinates with ViewManager.
 *
 * Path Handling:
 * - All internal path handling uses the `Path` class for normalized, cross-platform handling
 * - Project paths and workspace paths are stored as normalized strings (via path.toString())
 * - Map keys use normalized string paths for consistent lookup
 * - ViewManager receives string paths (will be migrated to Path in Step 5.5)
 */

import {
  createGitWorktreeProvider,
  KeepFilesService,
  Path,
  type IWorkspaceProvider,
  type PathProvider,
  type ProjectStore,
  type Workspace as InternalWorkspace,
  type FileSystemLayer,
  type LoggingService,
  type Logger,
  urlForFolder,
} from "../services";
import type { IViewManager } from "./managers/view-manager.interface";
import type { WorkspacePath } from "../shared/ipc";
import type { Project, ProjectId } from "../shared/api/types";
import { OpenCodeProvider } from "../agents/opencode/provider";
import type { AgentStatusManager } from "../agents";
import type { OpenCodeServerManager, PendingPrompt } from "../agents/opencode/server-manager";
import type { McpServerManager } from "../services/mcp-server";
import { getErrorMessage } from "../shared/error-utils";
import { toIpcWorkspaces } from "./api/workspace-conversion";
import { generateProjectId } from "../shared/api/id-utils";

/**
 * Runtime state for an open project.
 */
interface OpenProject {
  /** Project ID (generated from path) */
  readonly id: ProjectId;
  /** Project name (basename of path) */
  readonly name: string;
  /** Normalized project path */
  readonly path: Path;
  /** Internal workspaces (with Path-based paths) */
  readonly workspaces: readonly InternalWorkspace[];
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
  /**
   * Map of normalized project path strings to open project state.
   * Keys use path.toString() for consistent cross-platform lookup.
   */
  private readonly openProjects: Map<string, OpenProject> = new Map();
  /**
   * Map of normalized project path strings to last used base branch.
   */
  private readonly lastBaseBranches: Map<string, string> = new Map();
  private agentStatusManager: AgentStatusManager | null = null;
  private serverManager: OpenCodeServerManager | null = null;
  private mcpServerManager: McpServerManager | null = null;

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
    manager.onServerStarted((workspacePath, port, pendingPrompt) => {
      void this.handleServerStarted(workspacePath as WorkspacePath, port, pendingPrompt);
    });

    manager.onServerStopped((workspacePath, isRestart) => {
      if (this.agentStatusManager) {
        if (isRestart) {
          // For restart: disconnect but keep provider
          this.agentStatusManager.disconnectWorkspace(workspacePath as WorkspacePath);
        } else {
          // For permanent stop: remove workspace completely
          this.agentStatusManager.removeWorkspace(workspacePath as WorkspacePath);
        }
      }
      // Clear from MCP seen set so onFirstRequest fires again after restart
      if (this.mcpServerManager) {
        this.mcpServerManager.clearWorkspace(workspacePath);
      }
    });
  }

  /**
   * Handle server started event.
   * For restart: reconnects existing provider.
   * For first start: creates provider, registers with AgentStatusManager.
   * Sends initial prompt if provided.
   */
  private async handleServerStarted(
    workspacePath: WorkspacePath,
    port: number,
    pendingPrompt: PendingPrompt | undefined
  ): Promise<void> {
    if (!this.agentStatusManager) {
      return;
    }

    // Check if this is a restart (provider already exists from disconnect)
    if (this.agentStatusManager.hasProvider(workspacePath)) {
      // Restart: reconnect existing provider
      try {
        await this.agentStatusManager.reconnectWorkspace(workspacePath);
        this.logger.info("Reconnected OpenCode provider after restart", { workspacePath, port });
      } catch (error) {
        this.logger.error(
          "Failed to reconnect OpenCode provider",
          { workspacePath, port },
          error instanceof Error ? error : undefined
        );
      }
      return;
    }

    // First start: create new provider
    const provider = new OpenCodeProvider(
      workspacePath,
      this.agentStatusManager.getLogger(),
      this.agentStatusManager.getSdkFactory()
    );

    try {
      // Connect to server (connects SSE)
      await provider.connect(port);

      // Fetch initial status
      await provider.fetchStatus();

      // Register with AgentStatusManager
      this.agentStatusManager.addProvider(workspacePath, provider);

      // Send initial prompt if provided
      if (pendingPrompt) {
        const sessionResult = await provider.createSession();
        if (sessionResult.ok) {
          const promptResult = await provider.sendPrompt(
            sessionResult.value.id,
            pendingPrompt.prompt,
            {
              ...(pendingPrompt.agent !== undefined && { agent: pendingPrompt.agent }),
              ...(pendingPrompt.model !== undefined && { model: pendingPrompt.model }),
            }
          );
          if (!promptResult.ok) {
            this.logger.error("Failed to send initial prompt", {
              workspacePath,
              error: promptResult.error.message,
            });
          }
        } else {
          this.logger.error("Failed to create session for initial prompt", {
            workspacePath,
            error: sessionResult.error.message,
          });
        }
      }
    } catch (error) {
      this.logger.error(
        "Failed to initialize OpenCode provider",
        { workspacePath, port },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get the OpenCode server manager.
   */
  getServerManager(): OpenCodeServerManager | null {
    return this.serverManager;
  }

  /**
   * Set the MCP server manager.
   * Called from main process after creating services.
   */
  setMcpServerManager(manager: McpServerManager): void {
    this.mcpServerManager = manager;
  }

  /**
   * Sets the last used base branch for a project.
   * This is used to remember the user's branch selection within a session.
   *
   * @param projectPath - Path to the project (string, will be normalized)
   * @param branch - Branch name that was used
   */
  setLastBaseBranch(projectPath: string, branch: string): void {
    // Normalize the path for consistent Map key
    const normalizedKey = new Path(projectPath).toString();
    this.lastBaseBranches.set(normalizedKey, branch);
  }

  /**
   * Gets the default base branch for a project.
   * Returns the last used branch if set, otherwise falls back to provider's defaultBase().
   *
   * @param projectPath - Path to the project (string, will be normalized)
   * @returns The default branch name, or undefined if not determinable
   */
  async getDefaultBaseBranch(projectPath: string): Promise<string | undefined> {
    // Normalize the path for consistent Map lookup
    const normalizedKey = new Path(projectPath).toString();

    // Check runtime cache first
    const lastBranch = this.lastBaseBranches.get(normalizedKey);
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
        error: getErrorMessage(error),
      });
      return undefined;
    }
  }

  /**
   * Opens a project by path.
   * Validates it's a git repository, discovers workspaces, creates views.
   *
   * @param projectPathInput - Absolute path to the project (git repository)
   * @returns The opened Project (IPC type with string paths)
   * @throws WorkspaceError if path is not a valid git repository
   */
  async openProject(projectPathInput: string): Promise<Project> {
    // Normalize the project path immediately
    const projectPath = new Path(projectPathInput);
    const projectPathStr = projectPath.toString();

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
          { projectPath: projectPathStr },
          err instanceof Error ? err : undefined
        );
      });
    }

    // Discover existing workspaces (excludes main directory)
    // Returns internal Workspace with Path-based paths
    const workspaces = await provider.discover();

    // Create views for each workspace and start OpenCode servers
    // ViewManager still uses string paths (will be migrated in Step 5.5)
    for (const workspace of workspaces) {
      const workspacePathStr = workspace.path.toString();
      const url = this.getWorkspaceUrl(workspacePathStr);
      this.viewManager.createWorkspaceView(workspacePathStr, url, projectPathStr, true);
      this.startOpenCodeServerAsync(workspacePathStr);
    }

    // First workspace will be set as active after project is registered
    const firstWorkspace = workspaces[0];

    // Generate project ID from normalized path
    const projectId = generateProjectId(projectPathStr);

    // Store in internal state first (needed for getDefaultBaseBranch to work)
    this.openProjects.set(projectPathStr, {
      id: projectId,
      name: projectPath.basename,
      path: projectPath,
      workspaces,
      provider,
    });

    // Get default base branch (uses lastBaseBranches cache or provider fallback)
    const defaultBaseBranch = await this.getDefaultBaseBranch(projectPathStr);

    // Build IPC Project object with string-based paths
    const project: Project = {
      id: projectId,
      path: projectPathStr,
      name: projectPath.basename,
      workspaces: toIpcWorkspaces(workspaces, projectId),
      ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
    };

    // Set first workspace as active now that project is registered
    // (callback in setActiveWorkspace needs findProjectForWorkspace to work)
    // Only change active workspace if the new project has workspaces
    // If empty, keep the current active workspace (user can still work in other projects)
    if (firstWorkspace) {
      this.viewManager.setActiveWorkspace(firstWorkspace.path.toString());
    }

    // Preload remaining workspace URLs in parallel (fire-and-forget)
    // This loads code-server in background so switching workspaces is instant.
    // First workspace was loaded by setActiveWorkspace, so start from index 1.
    for (let i = 1; i < workspaces.length; i++) {
      const workspace = workspaces[i]!;
      this.viewManager.preloadWorkspaceUrl(workspace.path.toString());
    }

    // Persist to store
    await this.projectStore.saveProject(projectPathStr);

    return project;
  }

  /**
   * Closes a project.
   * Destroys all workspace views, cleans up state, and removes from persistent storage.
   *
   * @param projectPathInput - Path to the project to close
   */
  async closeProject(projectPathInput: string): Promise<void> {
    const normalizedKey = new Path(projectPathInput).toString();
    const openProject = this.openProjects.get(normalizedKey);
    if (!openProject) {
      return;
    }

    // Stop all OpenCode servers for this project
    if (this.serverManager) {
      await this.serverManager.stopAllForProject(normalizedKey);
    }

    // Destroy all workspace views
    for (const workspace of openProject.workspaces) {
      await this.viewManager.destroyWorkspaceView(workspace.path.toString());
    }

    // Remove from state
    this.openProjects.delete(normalizedKey);

    // Remove from persistent storage (fail silently)
    try {
      await this.projectStore.removeProject(normalizedKey);
    } catch {
      // Fail silently as per requirements
    }
  }

  /**
   * Gets a project by path.
   *
   * @param projectPathInput - Path to the project
   * @returns The Project (IPC type) or undefined if not open
   */
  getProject(projectPathInput: string): Project | undefined {
    const normalizedKey = new Path(projectPathInput).toString();
    const openProject = this.openProjects.get(normalizedKey);
    if (!openProject) {
      return undefined;
    }

    // Convert to IPC Project type
    return {
      id: openProject.id,
      path: openProject.path.toString(),
      name: openProject.name,
      workspaces: toIpcWorkspaces(openProject.workspaces, openProject.id),
    };
  }

  /**
   * Gets all open projects with current defaultBaseBranch.
   *
   * @returns Promise resolving to array of all open projects (IPC type)
   */
  async getAllProjects(): Promise<Project[]> {
    const result: Project[] = [];
    for (const openProject of this.openProjects.values()) {
      const projectPathStr = openProject.path.toString();
      const defaultBaseBranch = await this.getDefaultBaseBranch(projectPathStr);
      result.push({
        id: openProject.id,
        path: projectPathStr,
        name: openProject.name,
        workspaces: toIpcWorkspaces(openProject.workspaces, openProject.id),
        ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
      });
    }
    return result;
  }

  /**
   * Gets the workspace provider for a project.
   *
   * @param projectPathInput - Path to the project
   * @returns The IWorkspaceProvider or undefined if project not open
   */
  getWorkspaceProvider(projectPathInput: string): IWorkspaceProvider | undefined {
    const normalizedKey = new Path(projectPathInput).toString();
    return this.openProjects.get(normalizedKey)?.provider;
  }

  /**
   * Generates a code-server URL for a workspace.
   *
   * @param workspacePath - Absolute path to the workspace directory (string)
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
   * Uses Path class for proper cross-platform comparison.
   *
   * @param workspacePathInput - Path to the workspace
   * @returns The Project (IPC type) containing the workspace, or undefined
   */
  findProjectForWorkspace(workspacePathInput: string): Project | undefined {
    // Use Path.equals() for proper cross-platform comparison
    // This handles case-insensitivity on Windows and separator normalization
    const inputPath = new Path(workspacePathInput);

    for (const openProject of this.openProjects.values()) {
      const found = openProject.workspaces.find((w) => w.path.equals(inputPath));
      if (found) {
        // Convert to IPC Project type
        return {
          id: openProject.id,
          path: openProject.path.toString(),
          name: openProject.name,
          workspaces: toIpcWorkspaces(openProject.workspaces, openProject.id),
        };
      }
    }
    return undefined;
  }

  /**
   * Adds a workspace to an open project.
   * Creates a view and updates the project state.
   *
   * @param projectPathInput - Path to the project
   * @param workspace - The internal workspace to add (with Path-based path)
   * @param options - Optional options (e.g., initialPrompt)
   */
  addWorkspace(
    projectPathInput: string,
    workspace: InternalWorkspace,
    options?: { initialPrompt?: { prompt: string; agent?: string } }
  ): void {
    const normalizedKey = new Path(projectPathInput).toString();
    const openProject = this.openProjects.get(normalizedKey);
    if (!openProject) {
      return;
    }

    // Create view for the workspace (mark as new to show loading overlay)
    const workspacePathStr = workspace.path.toString();
    const url = this.getWorkspaceUrl(workspacePathStr);
    this.viewManager.createWorkspaceView(workspacePathStr, url, normalizedKey, true);

    // Preload the URL so VS Code starts loading in the background
    // This ensures the workspace is ready when the user switches to it
    this.viewManager.preloadWorkspaceUrl(workspacePathStr);

    // Update internal project state
    const updatedProject: OpenProject = {
      ...openProject,
      workspaces: [...openProject.workspaces, workspace],
    };

    this.openProjects.set(normalizedKey, updatedProject);

    // Start OpenCode server for the workspace (agent status tracking is wired via callback)
    this.startOpenCodeServerAsync(workspacePathStr, options?.initialPrompt);
  }

  /**
   * Start OpenCode server asynchronously with error logging.
   * Fire-and-forget pattern - failures are logged but don't block.
   *
   * @param workspacePath - Path to the workspace
   * @param initialPrompt - Optional initial prompt to send after server starts
   */
  private startOpenCodeServerAsync(
    workspacePath: string,
    initialPrompt?: { prompt: string; agent?: string }
  ): void {
    if (this.serverManager) {
      void this.serverManager
        .startServer(workspacePath, initialPrompt ? { initialPrompt } : undefined)
        .catch((err: unknown) => {
          this.logger.error(
            "Failed to start OpenCode server",
            { workspacePath },
            err instanceof Error ? err : undefined
          );
        });
    }
  }

  /**
   * Removes a workspace from an open project.
   * Destroys the view and updates the project state.
   *
   * @param projectPathInput - Path to the project
   * @param workspacePathInput - Path to the workspace to remove
   */
  async removeWorkspace(projectPathInput: string, workspacePathInput: string): Promise<void> {
    const normalizedKey = new Path(projectPathInput).toString();
    const openProject = this.openProjects.get(normalizedKey);
    if (!openProject) {
      return;
    }

    // Normalize workspace path for comparison
    const workspacePath = new Path(workspacePathInput);
    const workspacePathStr = workspacePath.toString();

    // Stop OpenCode server (this will trigger onServerStopped callback, which removes agent status)
    if (this.serverManager) {
      await this.serverManager.stopServer(workspacePathStr);
    }

    // Clear workspace from MCP seen set (so onFirstRequest fires if workspace is recreated)
    if (this.mcpServerManager) {
      this.mcpServerManager.clearWorkspace(workspacePathStr);
    }

    // Clear TUI tracking for permanent deletion (not restart)
    if (this.agentStatusManager) {
      this.agentStatusManager.clearTuiTracking(workspacePathStr as WorkspacePath);
    }

    // Destroy the workspace view
    await this.viewManager.destroyWorkspaceView(workspacePathStr);

    // Update internal project state using Path.equals() for comparison
    const updatedProject: OpenProject = {
      ...openProject,
      workspaces: openProject.workspaces.filter((w) => !w.path.equals(workspacePath)),
    };

    this.openProjects.set(normalizedKey, updatedProject);
  }
}
