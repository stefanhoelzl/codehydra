/**
 * Standalone LifecycleApi implementation.
 *
 * This class is instantiated early in bootstrap() before startServices() runs,
 * making lifecycle handlers available immediately when the renderer loads.
 *
 * The same instance is reused by CodeHydraApiImpl when it's created in startServices().
 *
 * Timing requirements:
 * 1. Created in bootstrap() after vscodeSetupService
 * 2. Lifecycle handlers registered immediately after creation
 * 3. Reused by CodeHydraApiImpl in startServices()
 */

import type { ILifecycleApi } from "../../shared/api/interfaces";
import type {
  SetupResult as ApiSetupResult,
  SetupProgress,
  AppState,
  SetupStep as ApiSetupStep,
} from "../../shared/api/types";
import type {
  IVscodeSetup,
  SetupStep as ServiceSetupStep,
} from "../../services/vscode-setup/types";
import type { Logger } from "../../services/logging/index";

/**
 * Minimal app interface required by LifecycleApi.
 */
export interface MinimalApp {
  quit(): void;
}

/**
 * Callback invoked when setup completes successfully.
 * Typically starts services in main process.
 */
export type OnSetupCompleteCallback = () => Promise<void>;

/**
 * Callback to emit setup progress events.
 * Typically sends to renderer via webContents.send().
 */
export type EmitProgressCallback = (progress: SetupProgress) => void;

/**
 * Standalone lifecycle API implementation.
 *
 * Provides getState(), setup(), and quit() methods for the setup flow.
 * Designed to be created early in bootstrap() and reused by CodeHydraApiImpl.
 */
export class LifecycleApi implements ILifecycleApi {
  private setupInProgress = false;

  constructor(
    private readonly vscodeSetup: IVscodeSetup,
    private readonly app: MinimalApp,
    private readonly onSetupComplete: OnSetupCompleteCallback,
    private readonly emitProgress: EmitProgressCallback,
    private readonly logger?: Logger
  ) {}

  /**
   * Get the current application state.
   * @returns "ready" if setup is complete, "setup" otherwise
   */
  async getState(): Promise<AppState> {
    const isComplete = await this.vscodeSetup.isSetupComplete();
    return isComplete ? "ready" : "setup";
  }

  /**
   * Run the setup process.
   *
   * Behavior:
   * - If setup is already complete: calls onSetupComplete and returns success
   * - If setup is already in progress: returns SETUP_IN_PROGRESS error
   * - Otherwise: cleans vscode dir, runs setup, emits progress, calls onSetupComplete on success
   *
   * @returns Success or failure result
   */
  async setup(): Promise<ApiSetupResult> {
    // Guard: prevent concurrent setup processes
    // IMPORTANT: Set flag BEFORE any await to prevent race conditions
    if (this.setupInProgress) {
      return {
        success: false,
        message: "Setup already in progress",
        code: "SETUP_IN_PROGRESS",
      };
    }
    this.setupInProgress = true;

    try {
      // Check if already complete
      const isComplete = await this.vscodeSetup.isSetupComplete();
      if (isComplete) {
        // Still need to call onSetupComplete (starts services)
        try {
          await this.onSetupComplete();
        } catch (error) {
          return {
            success: false,
            message: error instanceof Error ? error.message : String(error),
            code: "SERVICE_START_ERROR",
          };
        }
        return { success: true };
      }

      // Auto-clean before setup
      await this.vscodeSetup.cleanVscodeDir();

      // Run setup with progress callbacks
      const result = await this.vscodeSetup.setup((serviceProgress) => {
        this.logger?.debug("Setup progress", {
          step: serviceProgress.step,
          message: serviceProgress.message,
        });
        const apiStep = this.mapSetupStep(serviceProgress.step);
        if (apiStep) {
          this.emitProgress({
            step: apiStep,
            message: serviceProgress.message,
          });
        }
      });

      if (result.success) {
        this.logger?.info("Setup complete", {});
        // Call onSetupComplete (starts services)
        try {
          await this.onSetupComplete();
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger?.warn("Setup failed", { error: errorMessage });
          return {
            success: false,
            message: errorMessage,
            code: "SERVICE_START_ERROR",
          };
        }
        return { success: true };
      } else {
        this.logger?.warn("Setup failed", { error: result.error.message });
        return {
          success: false,
          message: result.error.message,
          code: result.error.code ?? result.error.type,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.warn("Setup failed", { error: errorMessage });
      return {
        success: false,
        message: errorMessage,
        code: "UNKNOWN",
      };
    } finally {
      this.setupInProgress = false;
    }
  }

  /**
   * Quit the application.
   */
  async quit(): Promise<void> {
    this.app.quit();
  }

  /**
   * Map service setup step to API setup step.
   * Returns undefined for steps that should be filtered out.
   */
  private mapSetupStep(serviceStep: ServiceSetupStep): ApiSetupStep | undefined {
    switch (serviceStep) {
      case "binary-download":
        return "binary-download";
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
