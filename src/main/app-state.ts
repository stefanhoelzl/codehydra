/**
 * Application state management.
 * Manages open projects and coordinates with ViewManager.
 *
 * Path Handling:
 * - All internal path handling uses the `Path` class for normalized, cross-platform handling
 * - Project paths and workspace paths are stored as normalized strings (via path.toString())
 * - Map keys use normalized string paths for consistent lookup
 * - ViewManager receives string paths (will be migrated to Path in Step 5.5)
 */

import {
  Path,
  type PathProvider,
  type ProjectStore,
  type Workspace as InternalWorkspace,
  type FileSystemLayer,
  type LoggingService,
  type Logger,
  type IWorkspaceFileService,
  urlForFolder,
  urlForWorkspace,
} from "../services";
import type { GitWorktreeProvider } from "../services/git/git-worktree-provider";
import type { IViewManager } from "./managers/view-manager.interface";
import type { WorkspacePath } from "../shared/ipc";
import type { Project, ProjectId } from "../shared/api/types";
import { OpenCodeProvider } from "../agents/opencode/provider";
import type { AgentStatusManager } from "../agents";
import { createAgentProvider, type AgentType } from "../agents";
import type { AgentServerManager } from "../agents/types";
import type { ClaudeCodeServerManager } from "../agents/claude/server-manager";
import type { PendingPrompt } from "../agents/opencode/server-manager";
import type { McpServerManager } from "../services/mcp-server";
import { getErrorMessage } from "../shared/error-utils";
import { toIpcWorkspaces } from "./api/workspace-conversion";

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
  /** Original git remote URL if project was cloned from URL */
  readonly remoteUrl?: string;
}

/**
 * Manages application state including open projects and workspace providers.
 */
export class AppState {
  private readonly projectStore: ProjectStore;
  private readonly globalProvider: GitWorktreeProvider;
  private codeServerPort: number;
  private readonly logger: Logger;
  private readonly agentType: AgentType;
  private readonly workspaceFileService: IWorkspaceFileService;
  private readonly wrapperPath: string;
  /**
   * Map of normalized project path strings to open project state.
   * Keys use path.toString() for consistent cross-platform lookup.
   */
  private readonly openProjects: Map<string, OpenProject> = new Map();
  /**
   * Map of normalized project path strings to default base branch.
   * Populated by explicit user selection during workspace creation (via setLastBaseBranch).
   */
  private readonly lastBaseBranches: Map<string, string> = new Map();
  private agentStatusManager: AgentStatusManager | null = null;
  private serverManager: AgentServerManager | null = null;
  private mcpServerManager: McpServerManager | null = null;
  /**
   * Tracks pending handleServerStarted() promises so callers can await provider registration.
   */
  private readonly serverStartedPromises: Map<string, Promise<void>> = new Map();

  constructor(
    projectStore: ProjectStore,
    _viewManager: IViewManager,
    _pathProvider: PathProvider,
    codeServerPort: number,
    _fileSystemLayer: FileSystemLayer,
    loggingService: LoggingService,
    agentType: AgentType,
    workspaceFileService: IWorkspaceFileService,
    wrapperPath: string,
    globalProvider: GitWorktreeProvider
  ) {
    this.projectStore = projectStore;
    this.globalProvider = globalProvider;
    this.codeServerPort = codeServerPort;
    this.logger = loggingService.createLogger("app");
    this.agentType = agentType;
    this.workspaceFileService = workspaceFileService;
    this.wrapperPath = wrapperPath;
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
   * Get the agent type configured for this application.
   * Used by the sidekick extension to determine which CLI to launch.
   *
   * @returns The configured agent type ("opencode" or "claude")
   */
  getAgentType(): AgentType {
    return this.agentType;
  }

  /**
   * Wait for the agent provider to be registered for a workspace.
   * Use after startServer() to ensure environment variables are available.
   *
   * @param workspacePath - Workspace path to wait for
   */
  async waitForProvider(workspacePath: string): Promise<void> {
    const promise = this.serverStartedPromises.get(workspacePath);
    if (promise) {
      await promise;
    }
  }

  /**
   * Set the agent server manager and wire callbacks.
   * Called from main process after creating services.
   */
  setServerManager(manager: AgentServerManager): void {
    this.serverManager = manager;

    // Wire server callbacks to agent status manager
    // Note: OpenCode passes (workspacePath, port, pendingPrompt)
    // Claude Code only passes (workspacePath, port)
    manager.onServerStarted((workspacePath, port, ...args) => {
      const pendingPrompt = args[0] as PendingPrompt | undefined;
      // Store promise so callers can await provider registration via waitForProvider()
      const promise = this.handleServerStarted(workspacePath as WorkspacePath, port, pendingPrompt);
      this.serverStartedPromises.set(workspacePath, promise);
    });

    // Note: OpenCode passes (workspacePath, isRestart)
    // Claude Code only passes (workspacePath)
    manager.onServerStopped((workspacePath, ...args) => {
      const isRestart = args[0] as boolean | undefined;
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
   * For OpenCode: sends initial prompt if provided.
   */
  private async handleServerStarted(
    workspacePath: WorkspacePath,
    port: number,
    pendingPrompt: PendingPrompt | undefined
  ): Promise<void> {
    try {
      if (!this.agentStatusManager) {
        return;
      }

      // Check if this is a restart (provider already exists from disconnect)
      if (this.agentStatusManager.hasProvider(workspacePath)) {
        // Restart: reconnect existing provider
        try {
          await this.agentStatusManager.reconnectWorkspace(workspacePath);
          this.logger.info("Reconnected agent provider after restart", {
            workspacePath,
            port,
            agentType: this.agentType,
          });
        } catch (error) {
          this.logger.error(
            "Failed to reconnect agent provider",
            { workspacePath, port, agentType: this.agentType },
            error instanceof Error ? error : undefined
          );
        }
        return;
      }

      // First start: create provider using factory
      const provider = createAgentProvider(this.agentType, {
        workspacePath,
        logger: this.agentStatusManager.getLogger(),
        sdkFactory:
          this.agentType === "opencode" ? this.agentStatusManager.getSdkFactory() : undefined,
        serverManager:
          this.agentType === "claude" ? (this.serverManager as ClaudeCodeServerManager) : undefined,
      });

      try {
        // Connect to server
        await provider.connect(port);

        // OpenCode-specific: fetch initial status and send initial prompt
        if (this.agentType === "opencode" && provider instanceof OpenCodeProvider) {
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
        } else {
          // Claude Code: just register the provider (no initial status fetch or prompt)
          this.agentStatusManager.addProvider(workspacePath, provider);
        }
      } catch (error) {
        this.logger.error(
          "Failed to initialize agent provider",
          { workspacePath, port, agentType: this.agentType },
          error instanceof Error ? error : undefined
        );
      }
    } finally {
      // Clean up the promise so subsequent waitForProvider calls return immediately
      this.serverStartedPromises.delete(workspacePath);
    }
  }

  /**
   * Get the agent server manager.
   */
  getServerManager(): AgentServerManager | null {
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
   * Update the code-server port.
   * Called by CodeServerLifecycleModule after code-server starts.
   */
  updateCodeServerPort(port: number): void {
    this.codeServerPort = port;
  }

  /**
   * Get the MCP server manager.
   */
  getMcpServerManager(): McpServerManager | null {
    return this.mcpServerManager;
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

    // Fall back to provider's default (only if project is open/registered)
    if (!this.isProjectOpen(projectPath)) {
      return undefined;
    }

    try {
      return await this.globalProvider.defaultBase(new Path(projectPath));
    } catch (error: unknown) {
      this.logger.warn("Failed to get default base branch", {
        projectPath,
        error: getErrorMessage(error),
      });
      return undefined;
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
      ...(openProject.remoteUrl !== undefined && { remoteUrl: openProject.remoteUrl }),
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
        ...(openProject.remoteUrl !== undefined && { remoteUrl: openProject.remoteUrl }),
      });
    }
    return result;
  }

  /**
   * Generates a code-server URL for a workspace.
   * Creates a .code-workspace file with agent-specific settings if it doesn't exist.
   *
   * @param workspacePath - Absolute path to the workspace directory (string)
   * @param agentEnvVars - Environment variables from the agent provider
   * @returns The code-server URL
   */
  async getWorkspaceUrl(
    workspacePath: string,
    agentEnvVars: Record<string, string>
  ): Promise<string> {
    try {
      const workspacePathObj = new Path(workspacePath);
      const projectWorkspacesDir = workspacePathObj.dirname;

      // Build settings from wrapper path + agent env vars
      // Convert env vars from Record<string, string> to {name, value}[] format expected by Claude extension
      const envVarsArray = Object.entries(agentEnvVars).map(([name, value]) => ({ name, value }));
      const agentSettings: Record<string, unknown> = {
        "claudeCode.useTerminal": true,
        "claudeCode.claudeProcessWrapper": this.wrapperPath,
        "claudeCode.environmentVariables": envVarsArray,
      };

      const workspaceFilePath = await this.workspaceFileService.ensureWorkspaceFile(
        workspacePathObj,
        projectWorkspacesDir,
        agentSettings
      );
      return urlForWorkspace(this.codeServerPort, workspaceFilePath.toString());
    } catch (error) {
      this.logger.warn("Failed to ensure workspace file, using folder URL", {
        workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return urlForFolder(this.codeServerPort, workspacePath);
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
          ...(openProject.remoteUrl !== undefined && { remoteUrl: openProject.remoteUrl }),
        };
      }
    }
    return undefined;
  }

  /**
   * Registers a workspace in the internal project state.
   * Updates the openProjects map to include the new workspace.
   * Does NOT handle view creation, agent startup, or URL generation --
   * those are handled by intent dispatcher hook/event modules.
   *
   * @param projectPathInput - Path to the project
   * @param workspace - The internal workspace to register (with Path-based path)
   */
  registerWorkspace(projectPathInput: string, workspace: InternalWorkspace): void {
    const normalizedKey = new Path(projectPathInput).toString();
    const openProject = this.openProjects.get(normalizedKey);
    if (!openProject) {
      return;
    }

    // Update internal project state
    const updatedProject: OpenProject = {
      ...openProject,
      workspaces: [...openProject.workspaces, workspace],
    };

    this.openProjects.set(normalizedKey, updatedProject);
  }

  /**
   * Registers a project in the internal state.
   * Used by the open-project operation's ProjectRegistryModule to store project state.
   * Does NOT handle view creation, agent startup, or workspace URL generation --
   * those are handled by workspace:create dispatches from the open-project operation.
   */
  registerProject(project: {
    id: ProjectId;
    name: string;
    path: Path;
    workspaces: readonly InternalWorkspace[];
    remoteUrl?: string;
  }): void {
    const projectPathStr = project.path.toString();
    this.openProjects.set(projectPathStr, {
      id: project.id,
      name: project.name,
      path: project.path,
      workspaces: project.workspaces,
      ...(project.remoteUrl !== undefined && { remoteUrl: project.remoteUrl }),
    });
  }

  /**
   * Removes a project from the internal state.
   * Used by the close-project operation's ProjectCloseRegistryModule.
   * Does NOT stop servers, destroy views, or delete files -- those are handled
   * by workspace:delete dispatches from the close-project operation.
   */
  deregisterProject(projectPathInput: string): void {
    const normalizedKey = new Path(projectPathInput).toString();
    this.openProjects.delete(normalizedKey);
    this.lastBaseBranches.delete(normalizedKey);
  }

  /**
   * Checks if a project with the given path is currently open.
   */
  isProjectOpen(projectPathInput: string): boolean {
    const normalizedKey = new Path(projectPathInput).toString();
    return this.openProjects.has(normalizedKey);
  }

  /**
   * Gets the project store (for use by hook modules).
   */
  getProjectStore(): ProjectStore {
    return this.projectStore;
  }

  /**
   * Removes a workspace from the internal project state.
   * Used by the delete-workspace state module to update state after deletion.
   * Does NOT stop servers, destroy views, or delete files -- those are handled
   * by hook modules in the delete-workspace operation.
   *
   * @param projectPathInput - Path to the project
   * @param workspacePathInput - Path to the workspace to remove
   */
  unregisterWorkspace(projectPathInput: string, workspacePathInput: string): void {
    const normalizedKey = new Path(projectPathInput).toString();
    const openProject = this.openProjects.get(normalizedKey);
    if (!openProject) {
      return;
    }

    const workspacePath = new Path(workspacePathInput);

    const updatedProject: OpenProject = {
      ...openProject,
      workspaces: openProject.workspaces.filter((w) => !w.path.equals(workspacePath)),
    };

    this.openProjects.set(normalizedKey, updatedProject);
  }
}
