/**
 * UiModule - Handles UI-related operations.
 *
 * Responsibilities:
 * - selectFolder: Show folder selection dialog
 * - getActiveWorkspace: Get currently active workspace
 * - switchWorkspace: Switch to a different workspace
 * - setMode: Set UI mode (workspace, shortcut, dialog, hover)
 *
 * Created in startServices() after setup is complete.
 */

import type {
  IApiRegistry,
  IApiModule,
  EmptyPayload,
  UiSwitchWorkspacePayload,
  UiSetModePayload,
} from "../../api/registry-types";
import type { WorkspaceRef } from "../../../shared/api/types";
import type { AppState } from "../../app-state";
import type { IViewManager } from "../../managers/view-manager.interface";
import type { Unsubscribe } from "../../../shared/api/interfaces";
import { ApiIpcChannels } from "../../../shared/ipc";
import { generateProjectId, extractWorkspaceName, resolveWorkspace } from "../../api/id-utils";

// =============================================================================
// Types
// =============================================================================

/**
 * Minimal dialog interface required by UiModule.
 */
export interface MinimalDialog {
  showOpenDialog(options: { properties: string[] }): Promise<{
    canceled: boolean;
    filePaths: string[];
  }>;
}

/**
 * Dependencies for UiModule.
 */
export interface UiModuleDeps {
  /** Application state manager */
  readonly appState: AppState;
  /** View manager for workspace views */
  readonly viewManager: IViewManager;
  /** Electron dialog for folder selection */
  readonly dialog: MinimalDialog;
}

// =============================================================================
// Module Implementation
// =============================================================================

/**
 * UiModule handles UI-related operations.
 *
 * Registered methods:
 * - ui.selectFolder: Show folder selection dialog
 * - ui.getActiveWorkspace: Get currently active workspace
 * - ui.switchWorkspace: Switch to a different workspace
 * - ui.setMode: Set UI mode
 *
 * Events emitted:
 * - workspace:switched: When active workspace changes
 * - ui:mode-changed: When UI mode changes (via ViewManager subscription)
 */
export class UiModule implements IApiModule {
  // Cleanup function for ViewManager mode change subscription
  private readonly unsubscribeModeChange: Unsubscribe;

  /**
   * Create a new UiModule.
   *
   * @param api The API registry to register methods on
   * @param deps Module dependencies
   */
  constructor(
    private readonly api: IApiRegistry,
    private readonly deps: UiModuleDeps
  ) {
    this.registerMethods();

    // Wire ViewManager mode changes to API events
    this.unsubscribeModeChange = this.deps.viewManager.onModeChange((event) => {
      this.api.emit("ui:mode-changed", event);
    });
  }

  /**
   * Register all UI methods with the API registry.
   */
  private registerMethods(): void {
    this.api.register("ui.selectFolder", this.selectFolder.bind(this), {
      ipc: ApiIpcChannels.UI_SELECT_FOLDER,
    });
    this.api.register("ui.getActiveWorkspace", this.getActiveWorkspace.bind(this), {
      ipc: ApiIpcChannels.UI_GET_ACTIVE_WORKSPACE,
    });
    this.api.register("ui.switchWorkspace", this.switchWorkspace.bind(this), {
      ipc: ApiIpcChannels.UI_SWITCH_WORKSPACE,
    });
    this.api.register("ui.setMode", this.setMode.bind(this), {
      ipc: ApiIpcChannels.UI_SET_MODE,
    });
  }

  // ===========================================================================
  // UI Methods
  // ===========================================================================

  private async selectFolder(payload: EmptyPayload): Promise<string | null> {
    void payload; // Required by MethodHandler interface but unused for no-arg methods
    const result = await this.deps.dialog.showOpenDialog({
      properties: ["openDirectory"],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0] ?? null;
  }

  private async getActiveWorkspace(payload: EmptyPayload): Promise<WorkspaceRef | null> {
    void payload; // Required by MethodHandler interface but unused for no-arg methods
    const activeWorkspacePath = this.deps.viewManager.getActiveWorkspacePath();
    if (!activeWorkspacePath) {
      return null;
    }

    const project = this.deps.appState.findProjectForWorkspace(activeWorkspacePath);
    if (!project) {
      return null;
    }

    const projectId = generateProjectId(project.path);
    const workspaceName = extractWorkspaceName(activeWorkspacePath);

    return {
      projectId,
      workspaceName,
      path: activeWorkspacePath,
    };
  }

  private async switchWorkspace(payload: UiSwitchWorkspacePayload): Promise<void> {
    const { workspace } = await resolveWorkspace(payload, this.deps.appState);

    const focus = payload.focus ?? true;
    // Note: workspace:switched event is emitted via ViewManager.onWorkspaceChange callback
    // wired in index.ts, not directly here
    this.deps.viewManager.setActiveWorkspace(workspace.path, focus);
  }

  private async setMode(payload: UiSetModePayload): Promise<void> {
    this.deps.viewManager.setMode(payload.mode);
  }

  // ===========================================================================
  // IApiModule Implementation
  // ===========================================================================

  dispose(): void {
    this.unsubscribeModeChange();
  }
}
