/**
 * CoreModule - Handles project and workspace operations.
 *
 * Responsibilities:
 * - Project operations: open, close, list, get, fetchBases
 * - Workspace operations: create, remove, forceRemove, get, getAgentSession
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
  WorkspaceCreatePayload,
  WorkspaceRemovePayload,
  WorkspaceRefPayload,
  WorkspaceExecuteCommandPayload,
  EmptyPayload,
} from "../../api/registry-types";
import type { PluginResult } from "../../../shared/plugin-protocol";
import type {
  ProjectId,
  WorkspaceName,
  Project,
  Workspace,
  BaseInfo,
  DeletionProgress,
  DeletionOperation,
  DeletionOperationId,
  BlockingProcess,
  AgentSession,
} from "../../../shared/api/types";
import { normalizeInitialPrompt } from "../../../shared/api/types";
import type { WorkspacePath } from "../../../shared/ipc";
import type { AppState } from "../../app-state";
import type { IViewManager } from "../../managers/view-manager.interface";
import type { Logger } from "../../../services/logging/index";
import type { WorkspaceLockHandler } from "../../../services/platform/workspace-lock-handler";
import { ApiIpcChannels } from "../../../shared/ipc";
import { SILENT_LOGGER } from "../../../services/logging";
import { getErrorMessage } from "../../../shared/error-utils";
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
 * Callback for emitting deletion progress events.
 */
export type DeletionProgressCallback = (progress: DeletionProgress) => void;

/**
 * Callback for killing terminals before workspace deletion.
 * Called with workspace path, should be best-effort (never throw).
 */
export type KillTerminalsCallback = (workspacePath: string) => Promise<void>;

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
  /** Callback for deletion progress events */
  readonly emitDeletionProgress: DeletionProgressCallback;
  /** Callback to kill terminals before workspace deletion */
  readonly killTerminalsCallback?: KillTerminalsCallback;
  /** Plugin server for executing VS Code commands in workspaces */
  readonly pluginServer?: IPluginServer;
  /** Handler for detecting and resolving processes blocking workspace deletion (Windows only, undefined on other platforms) */
  readonly workspaceLockHandler?: WorkspaceLockHandler | undefined;
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
 * - workspaces.*: create, remove, forceRemove, get
 *
 * Events emitted:
 * - project:opened, project:closed, project:bases-updated
 * - workspace:created, workspace:removed, workspace:switched,
 *   workspace:status-changed
 */
export class CoreModule implements IApiModule {
  private readonly logger: Logger;

  // Track in-progress deletions to prevent double-deletion
  private readonly inProgressDeletions = new Set<string>();

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

    // Workspace methods
    this.api.register("workspaces.create", this.workspaceCreate.bind(this), {
      ipc: ApiIpcChannels.WORKSPACE_CREATE,
    });
    this.api.register("workspaces.remove", this.workspaceRemove.bind(this), {
      ipc: ApiIpcChannels.WORKSPACE_REMOVE,
    });
    this.api.register("workspaces.forceRemove", this.workspaceForceRemove.bind(this), {
      ipc: ApiIpcChannels.WORKSPACE_FORCE_REMOVE,
    });
    this.api.register("workspaces.get", this.workspaceGet.bind(this), {
      ipc: ApiIpcChannels.WORKSPACE_GET,
    });
    this.api.register("workspaces.getAgentSession", this.workspaceGetAgentSession.bind(this), {
      ipc: ApiIpcChannels.WORKSPACE_GET_AGENT_SESSION,
    });
    this.api.register(
      "workspaces.restartAgentServer",
      this.workspaceRestartAgentServer.bind(this),
      {
        ipc: ApiIpcChannels.WORKSPACE_RESTART_AGENT_SERVER,
      }
    );
    // executeCommand is not exposed via IPC (only used by MCP/Plugin)
    this.api.register("workspaces.executeCommand", this.workspaceExecuteCommand.bind(this));
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

  private async workspaceCreate(payload: WorkspaceCreatePayload): Promise<Workspace> {
    const projectPath = await resolveProjectPath(payload.projectId, this.deps.appState);
    if (!projectPath) {
      throw new Error(`Project not found: ${payload.projectId}`);
    }

    const provider = this.deps.appState.getWorkspaceProvider(projectPath);
    if (!provider) {
      throw new Error(`No workspace provider for project: ${payload.projectId}`);
    }

    const internalWorkspace = await provider.createWorkspace(payload.name, payload.base);

    // Normalize initial prompt if provided
    const normalizedPrompt = payload.initialPrompt
      ? normalizeInitialPrompt(payload.initialPrompt)
      : undefined;

    // Add workspace and start server (with optional initial prompt)
    // Must await to ensure view is created before setActiveWorkspace is called
    await this.deps.appState.addWorkspace(
      projectPath,
      internalWorkspace,
      normalizedPrompt ? { initialPrompt: normalizedPrompt } : undefined
    );
    this.deps.appState.setLastBaseBranch(projectPath, payload.base);

    // Switch to the new workspace unless keepInBackground is true
    if (!payload.keepInBackground) {
      // focus=true ensures the new workspace receives keyboard events (e.g., Alt+X for shortcuts)
      this.deps.viewManager.setActiveWorkspace(internalWorkspace.path.toString(), true);
    }

    // Convert internal workspace (with Path) to API workspace (with string path)
    const workspace = this.toApiWorkspace(payload.projectId, {
      path: internalWorkspace.path.toString(),
      branch: internalWorkspace.branch,
      metadata: internalWorkspace.metadata,
    });

    // Emit workspace:created event with hasInitialPrompt and keepInBackground flags
    this.api.emit("workspace:created", {
      projectId: payload.projectId,
      workspace,
      ...(normalizedPrompt && { hasInitialPrompt: true }),
      ...(payload.keepInBackground && { keepInBackground: true }),
    });

    return workspace;
  }

  private async workspaceRemove(payload: WorkspaceRemovePayload): Promise<{ started: true }> {
    const { projectPath, workspace } = await this.resolveWorkspace(payload);

    // Check if deletion already in progress - return early (idempotent)
    if (this.inProgressDeletions.has(workspace.path)) {
      return { started: true };
    }

    // Mark as in-progress
    this.inProgressDeletions.add(workspace.path);

    // If this workspace is active and skipSwitch is not set, try to switch to next workspace
    const isActive = this.deps.viewManager.getActiveWorkspacePath() === workspace.path;
    if (isActive && !payload.skipSwitch) {
      const switched = await this.switchToNextWorkspaceIfAvailable(workspace.path);
      if (!switched) {
        // Note: workspace:switched event is emitted via ViewManager.onWorkspaceChange callback
        // wired in index.ts, not directly here
        this.deps.viewManager.setActiveWorkspace(null, false);
      }
    }

    // Fire-and-forget: execute deletion asynchronously
    const keepBranch = payload.keepBranch ?? true;
    const unblock = payload.unblock;
    const isRetry = payload.isRetry ?? false;
    void this.executeDeletion(
      payload.projectId,
      projectPath,
      workspace.path as WorkspacePath,
      payload.workspaceName,
      keepBranch,
      unblock,
      isRetry
    );

    return { started: true };
  }

  private async workspaceForceRemove(payload: WorkspaceRefPayload): Promise<void> {
    const { projectPath, workspace } = await this.resolveWorkspace(payload);

    const wasActive = this.deps.viewManager.getActiveWorkspacePath() === workspace.path;

    if (wasActive) {
      const switched = await this.switchToNextWorkspaceIfAvailable(workspace.path);
      if (!switched) {
        // Note: workspace:switched event is emitted via ViewManager.onWorkspaceChange callback
        // wired in index.ts, not directly here
        this.deps.viewManager.setActiveWorkspace(null, false);
      }
    }

    await this.deps.appState.removeWorkspace(projectPath, workspace.path);
    this.inProgressDeletions.delete(workspace.path);

    this.api.emit("workspace:removed", {
      projectId: payload.projectId,
      workspaceName: payload.workspaceName,
      path: workspace.path,
    });
  }

  private async workspaceGet(payload: WorkspaceRefPayload): Promise<Workspace | undefined> {
    const resolved = await this.tryResolveWorkspace(payload);
    if (!resolved) return undefined;

    return this.toApiWorkspace(payload.projectId, resolved.workspace);
  }

  private async workspaceGetAgentSession(
    payload: WorkspaceRefPayload
  ): Promise<AgentSession | null> {
    const { workspace } = await this.resolveWorkspace(payload);

    const agentStatusManager = this.deps.appState.getAgentStatusManager();
    return agentStatusManager?.getSession(workspace.path as WorkspacePath) ?? null;
  }

  private async workspaceRestartAgentServer(payload: WorkspaceRefPayload): Promise<number> {
    const { workspace } = await this.resolveWorkspace(payload);

    const serverManager = this.deps.appState.getServerManager();
    if (!serverManager) {
      throw new Error("Agent server manager not available");
    }

    const result = await serverManager.restartServer(workspace.path);
    if (!result.success) {
      throw new Error(result.error);
    }

    return result.port;
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

  private async switchToNextWorkspaceIfAvailable(currentWorkspacePath: string): Promise<boolean> {
    const allProjects = await this.deps.appState.getAllProjects();
    const statusManager = this.deps.appState.getAgentStatusManager();

    // 1. Build list sorted like UI (projects alphabetically, workspaces alphabetically)
    const sortedProjects = [...allProjects].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { caseFirst: "upper" })
    );

    const workspaces: Array<{ path: string }> = [];
    for (const project of sortedProjects) {
      const sortedWs = [...project.workspaces].sort((a, b) => {
        const nameA = extractWorkspaceName(a.path);
        const nameB = extractWorkspaceName(b.path);
        return nameA.localeCompare(nameB, undefined, { caseFirst: "upper" });
      });
      for (const ws of sortedWs) {
        workspaces.push({ path: ws.path });
      }
    }

    if (workspaces.length === 0) {
      return false;
    }

    // 2. Find current workspace index (position 0 in relative indexing)
    const currentIndex = workspaces.findIndex((w) => w.path === currentWorkspacePath);
    if (currentIndex === -1) {
      return false;
    }

    // 3. Calculate key for each workspace
    // Key = statusKey * workspaces.length + positionKey
    // Status: 0 = idle, 1 = busy, 2 = none, 3 = deleting
    // Position: 0 = current, 1 = next, 2 = next+1, ... (wrapping)
    const getKey = (ws: { path: string }, index: number): number => {
      // Status key: idle > busy > none > deleting
      let statusKey: number;
      if (this.inProgressDeletions.has(ws.path)) {
        statusKey = 3; // deleting
      } else {
        const status = statusManager?.getStatus(ws.path as WorkspacePath);
        if (!status || status.status === "none") {
          statusKey = 2; // none
        } else if (status.status === "busy") {
          statusKey = 1; // busy
        } else {
          statusKey = 0; // idle
        }
      }

      // Position key: relative to current workspace (current = 0, next = 1, ...)
      const positionKey = (index - currentIndex + workspaces.length) % workspaces.length;

      return statusKey * workspaces.length + positionKey;
    };

    // 4. Find workspace with lowest key (excluding current)
    let bestWorkspace: { path: string } | undefined;
    let bestKey = Infinity;

    for (let i = 0; i < workspaces.length; i++) {
      if (i === currentIndex) continue; // Skip current workspace
      const key = getKey(workspaces[i]!, i);
      if (key < bestKey) {
        bestKey = key;
        bestWorkspace = workspaces[i];
      }
    }

    if (!bestWorkspace) {
      return false;
    }

    // Note: workspace:switched event is emitted via ViewManager.onWorkspaceChange callback
    // wired in index.ts, not directly here
    // focus=true ensures the new workspace receives keyboard events (e.g., Alt+X for shortcuts)
    this.deps.viewManager.setActiveWorkspace(bestWorkspace.path, true);
    return true;
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
  // Deletion Execution
  // ===========================================================================

  private async executeDeletion(
    projectId: ProjectId,
    projectPath: string,
    workspacePath: WorkspacePath,
    workspaceName: WorkspaceName,
    keepBranch: boolean,
    unblock: "kill" | "close" | "ignore" | undefined,
    isRetry: boolean
  ): Promise<void> {
    // Build operations list - start with standard steps
    // Note: detecting-blockers is added conditionally between cleanup-vscode and cleanup-workspace
    const operations: DeletionOperation[] = [
      { id: "kill-terminals", label: "Terminating processes", status: "pending" },
      { id: "stop-server", label: "Stopping OpenCode server", status: "pending" },
      { id: "cleanup-vscode", label: "Closing VS Code view", status: "pending" },
      { id: "cleanup-workspace", label: "Removing workspace", status: "pending" },
    ];

    // Determine if we should run proactive detection
    // Run detection on first attempt only (not retry, not ignore)
    const shouldDetect = this.deps.workspaceLockHandler && !isRetry && unblock !== "ignore";

    // Track blocking processes detected during failure (Windows only)
    let blockingProcesses: readonly BlockingProcess[] | undefined;

    // Helper to prepend an operation at the start of the list
    const prependOp = (id: DeletionOperationId, label: string): void => {
      operations.unshift({ id, label, status: "pending" });
    };

    // Helper to add an operation at a specific index
    const addOp = (id: DeletionOperationId, label: string, afterId: DeletionOperationId): void => {
      const idx = operations.findIndex((op) => op.id === afterId);
      if (idx !== -1) {
        operations.splice(idx + 1, 0, { id, label, status: "pending" });
      } else {
        // Fallback: add at end
        operations.push({ id, label, status: "pending" });
      }
    };

    const emitProgress = (completed: boolean, hasErrors: boolean): void => {
      this.deps.emitDeletionProgress({
        workspacePath,
        workspaceName,
        projectId,
        keepBranch,
        operations: [...operations],
        completed,
        hasErrors,
        ...(blockingProcesses !== undefined && { blockingProcesses }),
      });
    };

    const updateOp = (
      id: DeletionOperationId,
      status: "pending" | "in-progress" | "done" | "error",
      error?: string
    ): void => {
      const idx = operations.findIndex((op) => op.id === id);
      const existing = operations[idx];
      if (idx !== -1 && existing) {
        operations[idx] = {
          id: existing.id,
          label: existing.label,
          status,
          ...(error !== undefined && { error }),
        };
      }
    };

    try {
      // Add detecting-blockers step if proactive detection is enabled
      if (shouldDetect) {
        addOp("detecting-blockers", "Detecting blocking processes...", "cleanup-vscode");
      }

      // Pre-step: Unblock by killing processes or closing handles (Windows only)
      if ((unblock === "kill" || unblock === "close") && this.deps.workspaceLockHandler) {
        if (unblock === "kill") {
          // Add the operation step and show spinner BEFORE the operation
          prependOp("killing-blockers", "Killing blocking tasks...");
          updateOp("killing-blockers", "in-progress");
          emitProgress(false, false);

          // Need to detect first to get the PIDs
          const detected = await this.deps.workspaceLockHandler.detect(new Path(workspacePath));
          if (detected.length > 0) {
            this.logger.info("Killing blocking processes before deletion", {
              workspacePath,
              pids: detected.map((p) => p.pid).join(","),
            });
            await this.deps.workspaceLockHandler.killProcesses(detected.map((p) => p.pid));
          }

          updateOp("killing-blockers", "done");
          emitProgress(false, false);
        } else if (unblock === "close") {
          // Add the operation step and show spinner BEFORE the operation
          prependOp("closing-handles", "Closing blocking handles...");
          updateOp("closing-handles", "in-progress");
          emitProgress(false, false);

          this.logger.info("Closing handles before deletion", { workspacePath });
          await this.deps.workspaceLockHandler.closeHandles(new Path(workspacePath));

          updateOp("closing-handles", "done");
          emitProgress(false, false);
        }
      } else {
        emitProgress(false, false);
      }

      // Operation 1: Kill terminals
      updateOp("kill-terminals", "in-progress");
      emitProgress(false, false);

      if (this.deps.killTerminalsCallback) {
        try {
          await this.deps.killTerminalsCallback(workspacePath);
          updateOp("kill-terminals", "done");
        } catch (error) {
          this.logger.warn("Kill terminals failed", {
            workspacePath,
            error: getErrorMessage(error),
          });
          updateOp("kill-terminals", "done");
        }
      } else {
        updateOp("kill-terminals", "done");
      }
      emitProgress(false, false);

      // Operation 2: Stop OpenCode server
      updateOp("stop-server", "in-progress");
      emitProgress(false, false);

      try {
        const serverManager = this.deps.appState.getServerManager();
        if (serverManager) {
          const stopResult = await serverManager.stopServer(workspacePath);
          if (stopResult.success) {
            updateOp("stop-server", "done");
          } else {
            updateOp("stop-server", "error", stopResult.error ?? "Failed to stop server");
          }
        } else {
          updateOp("stop-server", "done");
        }
        emitProgress(
          false,
          operations.some((op) => op.status === "error")
        );
      } catch (error) {
        updateOp("stop-server", "error", getErrorMessage(error));
        emitProgress(false, true);
      }

      // Operation 3: Cleanup VS Code view
      updateOp("cleanup-vscode", "in-progress");
      emitProgress(
        false,
        operations.some((op) => op.status === "error")
      );

      try {
        await this.deps.viewManager.destroyWorkspaceView(workspacePath);
        updateOp("cleanup-vscode", "done");
        emitProgress(
          false,
          operations.some((op) => op.status === "error")
        );
      } catch (error) {
        updateOp("cleanup-vscode", "error", getErrorMessage(error));
        emitProgress(false, true);
      }

      // Proactive detection: Run detection AFTER our cleanup to detect only EXTERNAL blockers
      // Skip detection on retry (user claims they fixed it) or ignore (power user escape hatch)
      if (shouldDetect) {
        updateOp("detecting-blockers", "in-progress");
        emitProgress(
          false,
          operations.some((op) => op.status === "error")
        );

        try {
          const detected = await this.deps.workspaceLockHandler!.detect(new Path(workspacePath));
          if (detected.length > 0) {
            blockingProcesses = detected;
            updateOp("detecting-blockers", "error", `Blocked by ${detected.length} process(es)`);
            emitProgress(true, true); // hasErrors: true stops here
            return; // Stop deletion, remaining steps stay pending
          }
          updateOp("detecting-blockers", "done");
          emitProgress(
            false,
            operations.some((op) => op.status === "error")
          );
        } catch (detectError) {
          // Detection error: show warning but continue with deletion (best-effort)
          this.logger.warn("Detection failed, continuing with deletion", {
            error: getErrorMessage(detectError),
          });
          updateOp("detecting-blockers", "done"); // Mark as done (not error)
          emitProgress(
            false,
            operations.some((op) => op.status === "error")
          );
        }
      }

      // Operation 4: Cleanup workspace (git worktree removal)
      updateOp("cleanup-workspace", "in-progress");
      emitProgress(
        false,
        operations.some((op) => op.status === "error")
      );

      try {
        const provider = this.deps.appState.getWorkspaceProvider(projectPath);
        if (provider) {
          // Convert branded string path to Path for provider method
          await provider.removeWorkspace(new Path(workspacePath), !keepBranch);
        }
        updateOp("cleanup-workspace", "done");
      } catch (error) {
        const errorCode = (error as NodeJS.ErrnoException).code;

        this.logger.debug("Workspace cleanup failed", {
          workspacePath,
          errorCode: errorCode ?? "none",
          errorType: error?.constructor?.name ?? "unknown",
          error: getErrorMessage(error),
        });

        // Detect blocking processes on Windows for ANY cleanup error.
        // We can't rely on error codes because git errors (GitError) don't preserve
        // the underlying filesystem error codes. The blocking process service
        // returns an empty array if no processes are found.
        if (this.deps.workspaceLockHandler) {
          try {
            const detected = await this.deps.workspaceLockHandler.detect(new Path(workspacePath));
            if (detected.length > 0) {
              blockingProcesses = detected;
              this.logger.info("Detected blocking processes", {
                workspacePath,
                count: detected.length,
              });
            }
          } catch (detectError) {
            this.logger.warn("Failed to detect blocking processes", {
              workspacePath,
              error: getErrorMessage(detectError),
            });
          }
        }

        updateOp("cleanup-workspace", "error", getErrorMessage(error));
      }

      // Finalize
      const hasErrors = operations.some((op) => op.status === "error");
      emitProgress(true, hasErrors);

      if (!hasErrors) {
        await this.deps.appState.removeWorkspace(projectPath, workspacePath);
        this.api.emit("workspace:removed", {
          projectId,
          workspaceName,
          path: workspacePath,
        });
      }
    } catch (error) {
      this.logger.error(
        "Unexpected error during workspace deletion",
        { workspacePath, workspaceName },
        error instanceof Error ? error : undefined
      );
      const errorMsg = getErrorMessage(error);

      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        if (op && op.status === "in-progress") {
          operations[i] = { id: op.id, label: op.label, status: "error", error: errorMsg };
        }
      }

      emitProgress(true, true);
    } finally {
      this.inProgressDeletions.delete(workspacePath);
    }
  }

  // ===========================================================================
  // IApiModule Implementation
  // ===========================================================================

  dispose(): void {
    // No resources to dispose (IPC handlers cleaned up by ApiRegistry)
  }
}
