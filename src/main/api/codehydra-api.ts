/**
 * CodeHydra API Implementation.
 * Stub file - implementation coming in subsequent steps.
 */
import * as path from "node:path";
import type { AppState } from "../app-state";
import type { IViewManager } from "../managers/view-manager.interface";
import type {
  ICodeHydraApi,
  IProjectApi,
  IWorkspaceApi,
  IUiApi,
  ILifecycleApi,
  ApiEvents,
  Unsubscribe,
} from "../../shared/api/interfaces";
import type {
  ProjectId,
  WorkspaceName,
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  BaseInfo,
  SetupResult,
  AppState as AppStateType,
  SetupStep as ApiSetupStep,
  DeletionProgress,
  DeletionOperation,
} from "../../shared/api/types";
import type { WorkspacePath } from "../../shared/ipc";
import type {
  IVscodeSetup,
  SetupStep as ServiceSetupStep,
} from "../../services/vscode-setup/types";
import { createSilentLogger, type Logger } from "../../services/logging";
import { generateProjectId } from "./id-utils";

type EventHandler<T = unknown> = (event: T) => void;

/**
 * Callback for emitting deletion progress events.
 */
export type DeletionProgressCallback = (progress: DeletionProgress) => void;

/**
 * Implementation of the CodeHydra API.
 * Wraps services and provides a unified interface for all consumers.
 */
export class CodeHydraApiImpl implements ICodeHydraApi {
  private readonly listeners = new Map<string, Set<EventHandler>>();

  readonly projects: IProjectApi;
  readonly workspaces: IWorkspaceApi;
  readonly ui: IUiApi;
  readonly lifecycle: ILifecycleApi;

  // Dependencies - some will be used in later implementation steps
  protected readonly viewManager: IViewManager;
  protected readonly dialog: typeof Electron.dialog;
  protected readonly electronApp: typeof Electron.app;
  protected readonly vscodeSetup: IVscodeSetup | undefined;

  // Deletion progress callback (injected for IPC emission)
  private readonly emitDeletionProgress: DeletionProgressCallback;

  // Track in-progress deletions to prevent double-deletion
  private readonly inProgressDeletions: Set<string> = new Set();

  // Cleanup function for ViewManager mode change subscription
  private readonly unsubscribeViewManagerModeChange: Unsubscribe;

  // Logger for API operations
  private readonly logger: Logger;

  constructor(
    private readonly appState: AppState,
    viewManager: IViewManager,
    dialog: typeof Electron.dialog,
    app: typeof Electron.app,
    vscodeSetup?: IVscodeSetup,
    existingLifecycleApi?: ILifecycleApi,
    emitDeletionProgress?: DeletionProgressCallback,
    logger?: Logger
  ) {
    this.viewManager = viewManager;
    this.dialog = dialog;
    this.electronApp = app;
    this.vscodeSetup = vscodeSetup;
    // Default to no-op if not provided
    this.emitDeletionProgress = emitDeletionProgress ?? (() => {});
    // Default to silent logger if not provided
    this.logger = logger ?? createSilentLogger();

    // Initialize domain APIs
    this.projects = this.createProjectApi();
    this.workspaces = this.createWorkspaceApi();
    this.ui = this.createUiApi();
    // Reuse existing LifecycleApi if provided (from bootstrap), otherwise create internal one
    this.lifecycle = existingLifecycleApi ?? this.createLifecycleApi();

    // Wire ViewManager mode changes to API events
    // This ensures mode changes from any source (ShortcutController, renderer)
    // are emitted to API subscribers
    this.unsubscribeViewManagerModeChange = this.viewManager.onModeChange((event) => {
      this.emit("ui:mode-changed", event);
    });
  }

  // ==========================================================================
  // Event Subscription
  // ==========================================================================

  on<E extends keyof ApiEvents>(event: E, handler: ApiEvents[E]): Unsubscribe {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler as EventHandler);

    return () => {
      this.listeners.get(event)?.delete(handler as EventHandler);
    };
  }

  /**
   * Emit an event to all subscribed handlers.
   * Exposed for testing purposes.
   */
  emit<E extends keyof ApiEvents>(event: E, payload: Parameters<ApiEvents[E]>[0]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        (handler as ApiEvents[E])(payload as never);
      } catch (error) {
        this.logger.error(
          "Error in event handler",
          { event },
          error instanceof Error ? error : undefined
        );
      }
    }
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  dispose(): void {
    this.unsubscribeViewManagerModeChange();
    this.listeners.clear();
  }

  // ==========================================================================
  // ID Resolution Helpers
  // ==========================================================================

  /**
   * Resolve a ProjectId to a project path by iterating all projects.
   * Returns undefined if not found.
   */
  private async resolveProjectPath(projectId: ProjectId): Promise<string | undefined> {
    const projects = await this.appState.getAllProjects();
    for (const project of projects) {
      if (generateProjectId(project.path) === projectId) {
        return project.path;
      }
    }
    return undefined;
  }

  /**
   * Convert an internal project (from AppState) to an API Project.
   */
  private toApiProject(
    internalProject: {
      path: string;
      name: string;
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
    };
  }

  /**
   * Convert an internal workspace to an API Workspace.
   */
  private toApiWorkspace(
    projectId: ProjectId,
    internalWorkspace: {
      path: string;
      branch?: string | null;
      metadata: Readonly<Record<string, string>>;
    }
  ): Workspace {
    const name = this.extractWorkspaceName(internalWorkspace.path) as WorkspaceName;
    return {
      projectId,
      name,
      branch: internalWorkspace.branch ?? null,
      metadata: internalWorkspace.metadata,
      path: internalWorkspace.path,
    };
  }

  /**
   * Extract workspace name from its path.
   * Uses path.basename() for cross-platform compatibility (Unix and Windows).
   */
  private extractWorkspaceName(workspacePath: string): string {
    return path.basename(workspacePath);
  }

  /**
   * Switch to the next available workspace, excluding the one being deleted.
   * Priority:
   * 1. Another workspace in the same project
   * 2. A workspace from another project
   *
   * @returns true if switched to another workspace, false if no other workspace available
   */
  private async switchToNextWorkspaceIfAvailable(
    currentProjectPath: string,
    excludeWorkspacePath: string
  ): Promise<boolean> {
    // Get all projects to find available workspaces
    const allProjects = await this.appState.getAllProjects();

    // First, try to find another workspace in the same project
    const currentProject = allProjects.find((p) => p.path === currentProjectPath);
    if (currentProject) {
      const otherWorkspace = currentProject.workspaces.find((w) => w.path !== excludeWorkspacePath);
      if (otherWorkspace) {
        const projectId = generateProjectId(currentProjectPath);
        const workspaceName = this.extractWorkspaceName(otherWorkspace.path) as WorkspaceName;
        this.viewManager.setActiveWorkspace(otherWorkspace.path, false);
        this.emit("workspace:switched", {
          projectId,
          workspaceName,
          path: otherWorkspace.path,
        });
        return true;
      }
    }

    // Second, try to find a workspace from another project
    for (const project of allProjects) {
      if (project.path === currentProjectPath) continue; // Skip current project
      const firstWorkspace = project.workspaces[0];
      if (firstWorkspace) {
        const projectId = generateProjectId(project.path);
        const workspaceName = this.extractWorkspaceName(firstWorkspace.path) as WorkspaceName;
        this.viewManager.setActiveWorkspace(firstWorkspace.path, false);
        this.emit("workspace:switched", {
          projectId,
          workspaceName,
          path: firstWorkspace.path,
        });
        return true;
      }
    }

    // No other workspace available - don't switch, stay on current
    return false;
  }

  // ==========================================================================
  // Deletion Execution
  // ==========================================================================

  /**
   * Execute deletion operations asynchronously with progress events.
   * This method is fire-and-forget from the caller's perspective.
   * Always emits completion event, even on unexpected errors.
   */
  private async executeDeletion(
    projectId: ProjectId,
    projectPath: string,
    workspacePath: WorkspacePath,
    workspaceName: WorkspaceName,
    keepBranch: boolean
  ): Promise<void> {
    // Build mutable operations array for tracking
    const operations: DeletionOperation[] = [
      { id: "cleanup-vscode", label: "Cleanup VS Code", status: "pending" },
      { id: "cleanup-workspace", label: "Cleanup workspace", status: "pending" },
    ];

    // Helper to emit full state
    const emitProgress = (completed: boolean, hasErrors: boolean): void => {
      this.emitDeletionProgress({
        workspacePath,
        workspaceName,
        projectId,
        keepBranch,
        operations: [...operations], // Copy to ensure immutability
        completed,
        hasErrors,
      });
    };

    // Helper to update operation status
    const updateOp = (
      id: "cleanup-vscode" | "cleanup-workspace",
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
      // Emit initial state
      emitProgress(false, false);

      // Note: Workspace switching is handled in remove() before executeDeletion is called.
      // This ensures immediate switch to next workspace for better UX.

      // ======================================================================
      // Operation 1: Cleanup VS Code (view destruction)
      // ======================================================================
      updateOp("cleanup-vscode", "in-progress");
      emitProgress(false, false);

      try {
        await this.viewManager.destroyWorkspaceView(workspacePath);
        updateOp("cleanup-vscode", "done");
        emitProgress(false, false);
      } catch (error) {
        const message = error instanceof Error ? error.message : "View cleanup failed";
        updateOp("cleanup-vscode", "error", message);
        emitProgress(false, true);
        // Continue to next operation - don't bail out
      }

      // ======================================================================
      // Operation 2: Cleanup workspace (git worktree removal)
      // ======================================================================
      updateOp("cleanup-workspace", "in-progress");
      emitProgress(
        false,
        operations.some((op) => op.status === "error")
      );

      try {
        // Get workspace provider
        const provider = this.appState.getWorkspaceProvider(projectPath);
        if (provider) {
          // Remove workspace via provider (deleteBase is inverted from keepBranch)
          await provider.removeWorkspace(workspacePath, !keepBranch);
        }
        updateOp("cleanup-workspace", "done");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Workspace cleanup failed";
        updateOp("cleanup-workspace", "error", message);
      }

      // ======================================================================
      // Finalize
      // ======================================================================
      const hasErrors = operations.some((op) => op.status === "error");

      // Emit final progress state
      emitProgress(true, hasErrors);

      // Only emit workspace:removed and update AppState if no errors
      if (!hasErrors) {
        // Update AppState (removes from internal tracking)
        await this.appState.removeWorkspace(projectPath, workspacePath);

        // Emit event
        this.emit("workspace:removed", {
          projectId,
          workspaceName,
          path: workspacePath,
        });
      }
    } catch (error) {
      // Unexpected error - always emit completion so UI isn't stuck in limbo
      this.logger.error(
        "Unexpected error during workspace deletion",
        { workspacePath, workspaceName },
        error instanceof Error ? error : undefined
      );
      const message = error instanceof Error ? error.message : "Deletion failed";

      // Mark any in-progress operation as error
      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        if (op && op.status === "in-progress") {
          operations[i] = { id: op.id, label: op.label, status: "error", error: message };
        }
      }

      emitProgress(true, true);
    } finally {
      // Always clear from in-progress set
      this.inProgressDeletions.delete(workspacePath);
    }
  }

  // ==========================================================================
  // Domain API Implementations
  // ==========================================================================

  private createProjectApi(): IProjectApi {
    return {
      open: async (path: string): Promise<Project> => {
        // Delegate to AppState to open the project
        const internalProject = await this.appState.openProject(path);
        const apiProject = this.toApiProject(internalProject);

        // Emit project:opened event
        this.emit("project:opened", { project: apiProject });

        return apiProject;
      },

      close: async (projectId: ProjectId): Promise<void> => {
        // Resolve project ID to path
        const projectPath = await this.resolveProjectPath(projectId);
        if (!projectPath) {
          throw new Error(`Project not found: ${projectId}`);
        }

        // Delegate to AppState to close the project
        await this.appState.closeProject(projectPath);

        // Emit project:closed event
        this.emit("project:closed", { projectId });
      },

      list: async (): Promise<readonly Project[]> => {
        const internalProjects = await this.appState.getAllProjects();
        return internalProjects.map((p) => this.toApiProject(p, p.defaultBaseBranch));
      },

      get: async (projectId: ProjectId): Promise<Project | undefined> => {
        const projectPath = await this.resolveProjectPath(projectId);
        if (!projectPath) return undefined;

        const internalProject = this.appState.getProject(projectPath);
        if (!internalProject) return undefined;

        const defaultBaseBranch = await this.appState.getDefaultBaseBranch(projectPath);
        return this.toApiProject(internalProject, defaultBaseBranch);
      },

      fetchBases: async (
        projectId: ProjectId
      ): Promise<{ readonly bases: readonly BaseInfo[] }> => {
        // Resolve project ID to path
        const projectPath = await this.resolveProjectPath(projectId);
        if (!projectPath) {
          throw new Error(`Project not found: ${projectId}`);
        }

        // Get workspace provider for this project
        const provider = this.appState.getWorkspaceProvider(projectPath);
        if (!provider) {
          throw new Error(`No workspace provider for project: ${projectId}`);
        }

        // Get current bases (cached)
        const bases = await provider.listBases();

        // Trigger background fetch - don't await
        void this.fetchBasesInBackground(projectId, provider);

        return { bases };
      },
    };
  }

  /**
   * Fetch bases in background and emit event when complete.
   */
  private async fetchBasesInBackground(
    projectId: ProjectId,
    provider: { updateBases(): Promise<unknown>; listBases(): Promise<readonly BaseInfo[]> }
  ): Promise<void> {
    try {
      await provider.updateBases();
      const updatedBases = await provider.listBases();
      this.emit("project:bases-updated", { projectId, bases: updatedBases });
    } catch (error) {
      this.logger.error(
        "Failed to fetch bases for project",
        { projectId },
        error instanceof Error ? error : undefined
      );
    }
  }

  private createWorkspaceApi(): IWorkspaceApi {
    return {
      create: async (projectId: ProjectId, name: string, base: string): Promise<Workspace> => {
        // Resolve project ID to path
        const projectPath = await this.resolveProjectPath(projectId);
        if (!projectPath) {
          throw new Error(`Project not found: ${projectId}`);
        }

        // Get workspace provider
        const provider = this.appState.getWorkspaceProvider(projectPath);
        if (!provider) {
          throw new Error(`No workspace provider for project: ${projectId}`);
        }

        // Create workspace via provider
        const internalWorkspace = await provider.createWorkspace(name, base);

        // Update AppState
        this.appState.addWorkspace(projectPath, internalWorkspace);

        // Remember last used base branch
        this.appState.setLastBaseBranch(projectPath, base);

        // Convert to API workspace
        const workspace = this.toApiWorkspace(projectId, internalWorkspace);

        // Emit event
        this.emit("workspace:created", { projectId, workspace });

        return workspace;
      },

      remove: async (
        projectId: ProjectId,
        workspaceName: WorkspaceName,
        keepBranch = true
      ): Promise<{ started: true }> => {
        // Resolve project ID to path
        const projectPath = await this.resolveProjectPath(projectId);
        if (!projectPath) {
          throw new Error(`Project not found: ${projectId}`);
        }

        // Find workspace path
        const internalProject = this.appState.getProject(projectPath);
        if (!internalProject) {
          throw new Error(`Project not found: ${projectId}`);
        }

        const workspace = internalProject.workspaces.find(
          (w) => this.extractWorkspaceName(w.path) === workspaceName
        );
        if (!workspace) {
          throw new Error(`Workspace not found: ${workspaceName}`);
        }

        // Check if deletion already in progress - return early (idempotent)
        if (this.inProgressDeletions.has(workspace.path)) {
          return { started: true };
        }

        // Mark as in-progress
        this.inProgressDeletions.add(workspace.path);

        // If this workspace is active, try to switch to next workspace immediately.
        // This provides better UX - user sees the next workspace right away instead of
        // watching deletion progress. If no other workspace exists, stay on current
        // (deletion progress view will be shown by the renderer).
        const isActive = this.viewManager.getActiveWorkspacePath() === workspace.path;
        if (isActive) {
          await this.switchToNextWorkspaceIfAvailable(projectPath, workspace.path);
        }

        // Fire-and-forget: execute deletion asynchronously
        void this.executeDeletion(
          projectId,
          projectPath,
          workspace.path as WorkspacePath,
          workspaceName,
          keepBranch
        );

        // Return immediately
        return { started: true };
      },

      forceRemove: async (projectId: ProjectId, workspaceName: WorkspaceName): Promise<void> => {
        // Resolve project ID to path
        const projectPath = await this.resolveProjectPath(projectId);
        if (!projectPath) {
          throw new Error(`Project not found: ${projectId}`);
        }

        // Find workspace path
        const internalProject = this.appState.getProject(projectPath);
        if (!internalProject) {
          throw new Error(`Project not found: ${projectId}`);
        }

        const workspace = internalProject.workspaces.find(
          (w) => this.extractWorkspaceName(w.path) === workspaceName
        );
        if (!workspace) {
          throw new Error(`Workspace not found: ${workspaceName}`);
        }

        // Check if removed workspace was active
        const wasActive = this.viewManager.getActiveWorkspacePath() === workspace.path;

        // If active, try to switch to next workspace immediately
        // (for forceRemove we do this before cleanup since cleanup is instant)
        if (wasActive) {
          const switched = await this.switchToNextWorkspaceIfAvailable(projectPath, workspace.path);
          // If no other workspace available, set to null (workspace is being force-removed)
          if (!switched) {
            this.viewManager.setActiveWorkspace(null, false);
            this.emit("workspace:switched", null);
          }
        }

        // Clean up internal state WITHOUT running cleanup operations
        await this.appState.removeWorkspace(projectPath, workspace.path);

        // Clear in-progress deletion tracking
        this.inProgressDeletions.delete(workspace.path);

        // Emit event
        this.emit("workspace:removed", {
          projectId,
          workspaceName,
          path: workspace.path,
        });
      },

      get: async (
        projectId: ProjectId,
        workspaceName: WorkspaceName
      ): Promise<Workspace | undefined> => {
        const projectPath = await this.resolveProjectPath(projectId);
        if (!projectPath) return undefined;

        const internalProject = this.appState.getProject(projectPath);
        if (!internalProject) return undefined;

        const workspace = internalProject.workspaces.find(
          (w) => this.extractWorkspaceName(w.path) === workspaceName
        );
        if (!workspace) return undefined;

        return this.toApiWorkspace(projectId, workspace);
      },

      getStatus: async (
        projectId: ProjectId,
        workspaceName: WorkspaceName
      ): Promise<WorkspaceStatus> => {
        // Resolve project ID to path
        const projectPath = await this.resolveProjectPath(projectId);
        if (!projectPath) {
          throw new Error(`Project not found: ${projectId}`);
        }

        // Find workspace path
        const internalProject = this.appState.getProject(projectPath);
        if (!internalProject) {
          throw new Error(`Project not found: ${projectId}`);
        }

        const workspace = internalProject.workspaces.find(
          (w) => this.extractWorkspaceName(w.path) === workspaceName
        );
        if (!workspace) {
          throw new Error(`Workspace not found: ${workspaceName}`);
        }

        // Get workspace provider for isDirty check
        const provider = this.appState.getWorkspaceProvider(projectPath);
        const isDirty = provider ? await provider.isDirty(workspace.path) : false;

        // Get agent status
        const agentStatusManager = this.appState.getAgentStatusManager();
        if (!agentStatusManager) {
          return { isDirty, agent: { type: "none" } };
        }

        const agentStatus = agentStatusManager.getStatus(workspace.path as WorkspacePath);
        if (!agentStatus || agentStatus.status === "none") {
          return { isDirty, agent: { type: "none" } };
        }

        return {
          isDirty,
          agent: {
            type: agentStatus.status,
            counts: {
              idle: agentStatus.counts.idle,
              busy: agentStatus.counts.busy,
              total: agentStatus.counts.idle + agentStatus.counts.busy,
            },
          },
        };
      },

      setMetadata: async (
        projectId: ProjectId,
        workspaceName: WorkspaceName,
        key: string,
        value: string | null
      ): Promise<void> => {
        // Resolve project ID to path
        const projectPath = await this.resolveProjectPath(projectId);
        if (!projectPath) {
          throw new Error(`Project not found: ${projectId}`);
        }

        // Find workspace path
        const internalProject = this.appState.getProject(projectPath);
        if (!internalProject) {
          throw new Error(`Project not found: ${projectId}`);
        }

        const workspace = internalProject.workspaces.find(
          (w) => this.extractWorkspaceName(w.path) === workspaceName
        );
        if (!workspace) {
          throw new Error(`Workspace not found: ${workspaceName}`);
        }

        // Get workspace provider
        const provider = this.appState.getWorkspaceProvider(projectPath);
        if (!provider) {
          throw new Error(`No workspace provider for project: ${projectId}`);
        }

        // Delegate to provider
        await provider.setMetadata(workspace.path, key, value);

        // Emit event
        this.emit("workspace:metadata-changed", {
          projectId,
          workspaceName,
          key,
          value,
        });
      },

      getMetadata: async (
        projectId: ProjectId,
        workspaceName: WorkspaceName
      ): Promise<Readonly<Record<string, string>>> => {
        // Resolve project ID to path
        const projectPath = await this.resolveProjectPath(projectId);
        if (!projectPath) {
          throw new Error(`Project not found: ${projectId}`);
        }

        // Find workspace path
        const internalProject = this.appState.getProject(projectPath);
        if (!internalProject) {
          throw new Error(`Project not found: ${projectId}`);
        }

        const workspace = internalProject.workspaces.find(
          (w) => this.extractWorkspaceName(w.path) === workspaceName
        );
        if (!workspace) {
          throw new Error(`Workspace not found: ${workspaceName}`);
        }

        // Get workspace provider
        const provider = this.appState.getWorkspaceProvider(projectPath);
        if (!provider) {
          throw new Error(`No workspace provider for project: ${projectId}`);
        }

        // Delegate to provider
        return provider.getMetadata(workspace.path);
      },
    };
  }

  private createUiApi(): IUiApi {
    return {
      selectFolder: async (): Promise<string | null> => {
        const result = await this.dialog.showOpenDialog({
          properties: ["openDirectory"],
        });

        if (result.canceled || result.filePaths.length === 0) {
          return null;
        }

        return result.filePaths[0] ?? null;
      },

      getActiveWorkspace: async (): Promise<WorkspaceRef | null> => {
        const activeWorkspacePath = this.viewManager.getActiveWorkspacePath();
        if (!activeWorkspacePath) {
          return null;
        }

        // Find the project containing this workspace
        const project = this.appState.findProjectForWorkspace(activeWorkspacePath);
        if (!project) {
          return null;
        }

        const projectId = generateProjectId(project.path);
        const workspaceName = this.extractWorkspaceName(activeWorkspacePath) as WorkspaceName;

        return {
          projectId,
          workspaceName,
          path: activeWorkspacePath,
        };
      },

      switchWorkspace: async (
        projectId: ProjectId,
        workspaceName: WorkspaceName,
        focus = true
      ): Promise<void> => {
        // Resolve project ID to path
        const projectPath = await this.resolveProjectPath(projectId);
        if (!projectPath) {
          throw new Error(`Project not found: ${projectId}`);
        }

        // Find workspace path
        const internalProject = this.appState.getProject(projectPath);
        if (!internalProject) {
          throw new Error(`Project not found: ${projectId}`);
        }

        const workspace = internalProject.workspaces.find(
          (w) => this.extractWorkspaceName(w.path) === workspaceName
        );
        if (!workspace) {
          throw new Error(`Workspace not found: ${workspaceName}`);
        }

        // Switch via ViewManager
        this.viewManager.setActiveWorkspace(workspace.path, focus);

        // Emit event
        this.emit("workspace:switched", {
          projectId,
          workspaceName,
          path: workspace.path,
        });
      },

      setMode: async (mode): Promise<void> => {
        this.viewManager.setMode(mode);
      },
    };
  }

  private createLifecycleApi(): ILifecycleApi {
    return {
      getState: async (): Promise<AppStateType> => {
        if (!this.vscodeSetup) {
          // If no setup service provided, assume ready
          return "ready";
        }
        const isComplete = await this.vscodeSetup.isSetupComplete();
        return isComplete ? "ready" : "setup";
      },

      setup: async (): Promise<SetupResult> => {
        if (!this.vscodeSetup) {
          return { success: true };
        }

        // Create a progress callback that translates service types to API types
        // and emits setup:progress events
        const onProgress = (serviceProgress: { step: ServiceSetupStep; message: string }): void => {
          // Map service steps to API steps
          const apiStep = this.mapSetupStep(serviceProgress.step);
          if (apiStep) {
            this.emit("setup:progress", {
              step: apiStep,
              message: serviceProgress.message,
            });
          }
        };

        const serviceResult = await this.vscodeSetup.setup(onProgress);

        // Translate service result to API result
        if (serviceResult.success) {
          return { success: true };
        } else {
          return {
            success: false,
            message: serviceResult.error.message,
            code: serviceResult.error.code ?? "UNKNOWN",
          };
        }
      },

      quit: async (): Promise<void> => {
        this.electronApp.quit();
      },
    };
  }

  /**
   * Map service setup step to API setup step.
   * Returns undefined for steps that should be filtered out.
   */
  private mapSetupStep(serviceStep: ServiceSetupStep): ApiSetupStep | undefined {
    switch (serviceStep) {
      case "extensions":
        return "extensions";
      case "config":
        return "settings";
      case "finalize":
        // Finalize step is not exposed in the API
        return undefined;
      default:
        return undefined;
    }
  }
}
