/**
 * CoreModule - Handles workspace command execution and UI operations.
 *
 * Responsibilities:
 * - Workspace operations: executeCommand (for Plugin API / MCP)
 * - UI operations: selectFolder
 *
 * Note: workspace create/remove, project open/close/clone, ui.switchWorkspace,
 * and all project/workspace queries are handled by the intent dispatcher or
 * event-driven renderer stores.
 *
 * Created in startServices() after setup is complete.
 */

import type {
  IApiRegistry,
  IApiModule,
  WorkspaceExecuteCommandPayload,
  EmptyPayload,
} from "../../api/registry-types";
import type { PluginResult } from "../../../shared/plugin-protocol";
import { ApiIpcChannels } from "../../../shared/ipc";

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
  /** Code-server port for URL generation (updated by CodeServerLifecycleModule) */
  readonly codeServerPort: number;
  /** Wrapper path for Claude Code wrapper script */
  readonly wrapperPath: string;
  /** Plugin server for executing VS Code commands in workspaces */
  readonly pluginServer?: IPluginServer;
  /** Electron dialog for folder selection */
  readonly dialog?: MinimalDialog;
}

// =============================================================================
// Module Implementation
// =============================================================================

/**
 * CoreModule handles workspace command execution and UI operations.
 *
 * Registered methods:
 * - workspaces.executeCommand
 * - ui.selectFolder
 *
 * Note: workspaces.create/remove, projects.open/close/clone, and ui.switchWorkspace
 * are handled by the intent dispatcher.
 */
export class CoreModule implements IApiModule {
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
    this.registerMethods();
  }

  /**
   * Register workspace command and UI methods with the API registry.
   */
  private registerMethods(): void {
    // executeCommand is not exposed via IPC (only used by MCP/Plugin)
    this.api.register("workspaces.executeCommand", this.workspaceExecuteCommand.bind(this));

    // UI methods (relocated from UiModule)
    // Note: ui.switchWorkspace is handled by the intent dispatcher in bootstrap.ts
    this.api.register("ui.selectFolder", this.selectFolder.bind(this), {
      ipc: ApiIpcChannels.UI_SELECT_FOLDER,
    });
  }

  // ===========================================================================
  // Workspace Methods
  // ===========================================================================

  private async workspaceExecuteCommand(payload: WorkspaceExecuteCommandPayload): Promise<unknown> {
    if (!this.deps.pluginServer) {
      throw new Error("Plugin server not available");
    }

    const result = await this.deps.pluginServer.sendCommand(
      payload.workspacePath,
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
  // IApiModule Implementation
  // ===========================================================================

  dispose(): void {
    // No resources to dispose (IPC handlers cleaned up by ApiRegistry)
  }
}
