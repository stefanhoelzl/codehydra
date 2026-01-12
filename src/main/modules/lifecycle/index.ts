/**
 * LifecycleModule - Handles application lifecycle operations.
 *
 * Responsibilities:
 * - getState: Check if setup is needed and return agent info
 * - setAgent: Save agent selection to config
 * - setup: Run VS Code setup process
 * - quit: Quit the application
 *
 * Created in bootstrap() before UI loads, making lifecycle handlers
 * available immediately when the renderer starts.
 */

import type { IApiRegistry, IApiModule, EmptyPayload } from "../../api/registry-types";
import type {
  SetupResult,
  AppStateResult,
  ConfigAgentType,
  SetupRowId,
  SetupRowProgress,
  SetupScreenProgress,
} from "../../../shared/api/types";
import type {
  IVscodeSetup,
  PreflightResult,
  SetupStep,
  SetupProgress,
  BinaryType,
} from "../../../services/vscode-setup/types";
import type { ConfigService } from "../../../services/config/config-service";
import type { Logger } from "../../../services/logging/index";
import { ApiIpcChannels } from "../../../shared/ipc";
import { SILENT_LOGGER } from "../../../services/logging";
import { getErrorMessage } from "../../../shared/error-utils";

// =============================================================================
// Types
// =============================================================================

/**
 * Minimal app interface required by LifecycleModule.
 */
export interface MinimalApp {
  quit(): void;
}

/**
 * Dependencies for LifecycleModule.
 */
export interface LifecycleModuleDeps {
  /**
   * Factory to get VS Code setup service for the current agent type.
   * Returns undefined in dev mode without setup.
   * The factory re-reads the config to get the currently selected agent.
   */
  readonly getVscodeSetup: () => Promise<IVscodeSetup | undefined>;
  /** Config service for loading/saving agent selection */
  readonly configService: ConfigService;
  /** Electron app instance for quit() */
  readonly app: MinimalApp;
  /** Function to start application services (code-server, OpenCode, etc.) */
  readonly doStartServices: () => Promise<void>;
  /** Optional logger */
  readonly logger?: Logger;
}

/**
 * Payload for setAgent IPC call.
 */
interface SetAgentPayload {
  readonly agent: ConfigAgentType;
}

// =============================================================================
// Progress Mapping Helpers
// =============================================================================

/**
 * Map internal setup step and binary type to row ID.
 */
function mapStepToRowId(step: SetupStep, binaryType?: BinaryType): SetupRowId {
  switch (step) {
    case "binary-download":
      // Binary download: code-server -> vscode row, agent binaries -> agent row
      if (binaryType === "code-server") {
        return "vscode";
      }
      if (binaryType === "opencode" || binaryType === "claude") {
        return "agent";
      }
      // Fallback to vscode for unknown binary types
      return "vscode";
    case "extensions":
    case "config":
    case "finalize":
      return "setup";
    default:
      return "setup";
  }
}

/**
 * Create a row progress update from setup progress.
 */
function createRowProgress(
  serviceProgress: SetupProgress,
  rowStates: Map<SetupRowId, SetupRowProgress>
): SetupScreenProgress {
  const rowId = mapStepToRowId(serviceProgress.step, serviceProgress.binaryType);

  // Update the specific row to running with optional progress percentage
  const updatedRow: SetupRowProgress = {
    id: rowId,
    status: "running",
    message: serviceProgress.message,
    ...(serviceProgress.percent !== undefined && { progress: serviceProgress.percent }),
  };
  rowStates.set(rowId, updatedRow);

  // Build rows array in order
  const rows: SetupRowProgress[] = [];
  for (const id of ["vscode", "agent", "setup"] as SetupRowId[]) {
    const row = rowStates.get(id);
    if (row) {
      rows.push(row);
    } else {
      rows.push({ id, status: "pending" });
    }
  }

  return { rows };
}

// =============================================================================
// Module Implementation
// =============================================================================

/**
 * LifecycleModule handles application lifecycle operations.
 *
 * Registered methods:
 * - lifecycle.getState: Check if setup is needed and return agent info
 * - lifecycle.setAgent: Save agent selection to config
 * - lifecycle.setup: Run VS Code setup process
 * - lifecycle.quit: Quit the application
 */
export class LifecycleModule implements IApiModule {
  private setupInProgress = false;
  /** Cached preflight result from getState() for use in setup() */
  private cachedPreflightResult: PreflightResult | null = null;
  /** Flag to track if services have been started (idempotent guard) */
  private servicesStarted = false;

  private readonly logger: Logger;

  /**
   * Create a new LifecycleModule.
   *
   * @param api The API registry to register methods on
   * @param deps Module dependencies
   */
  constructor(
    private readonly api: IApiRegistry,
    private readonly deps: LifecycleModuleDeps
  ) {
    this.logger = deps.logger ?? SILENT_LOGGER;
    this.registerMethods();
  }

  /**
   * Register all lifecycle methods with the API registry.
   */
  private registerMethods(): void {
    this.api.register("lifecycle.getState", this.getState.bind(this), {
      ipc: ApiIpcChannels.LIFECYCLE_GET_STATE,
    });
    this.api.register("lifecycle.setAgent", this.setAgent.bind(this), {
      ipc: ApiIpcChannels.LIFECYCLE_SET_AGENT,
    });
    this.api.register("lifecycle.setup", this.setup.bind(this), {
      ipc: ApiIpcChannels.LIFECYCLE_SETUP,
    });
    this.api.register("lifecycle.startServices", this.startServices.bind(this), {
      ipc: ApiIpcChannels.LIFECYCLE_START_SERVICES,
    });
    this.api.register("lifecycle.quit", this.quit.bind(this), {
      ipc: ApiIpcChannels.LIFECYCLE_QUIT,
    });
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Get the current application state.
   *
   * Flow:
   * 1. Load config to check if agent is selected
   * 2. If agent is null, return "agent-selection" state
   * 3. Otherwise, run preflight checks to determine if setup is needed
   *
   * The preflight result is cached for use by setup().
   *
   * Returns:
   * - { state: "agent-selection", agent: null } if agent not selected
   * - { state: "setup", agent } if setup is needed
   * - { state: "loading", agent } if setup is complete but services not yet started
   * - Never returns "ready" (that state is only reached after startServices())
   */
  private async getState(payload: EmptyPayload): Promise<AppStateResult> {
    void payload; // Required by MethodHandler interface but unused for no-arg methods

    // Load config to check if agent is selected
    const config = await this.deps.configService.load();

    // If agent is not selected, return agent-selection state
    if (config.agent === null) {
      this.logger.info("Agent not selected, showing selection dialog", {});
      return { state: "agent-selection", agent: null };
    }

    // Get setup service for the current agent type
    const vscodeSetup = await this.deps.getVscodeSetup();

    // If no setup service, return "loading" (skip setup, but still need to start services)
    if (!vscodeSetup) {
      return { state: "loading", agent: config.agent };
    }

    const preflightResult = await vscodeSetup.preflight();

    // Cache for later use in setup()
    this.cachedPreflightResult = preflightResult;

    // Log preflight results
    if (preflightResult.success) {
      if (preflightResult.needsSetup) {
        this.logger.info("Preflight: setup required", {
          missingBinaries: preflightResult.missingBinaries.join(",") || "none",
          missingExtensions: preflightResult.missingExtensions.join(",") || "none",
          outdatedExtensions: preflightResult.outdatedExtensions.join(",") || "none",
        });
        return { state: "setup", agent: config.agent };
      } else {
        this.logger.debug("Preflight: no setup required", {});
        return { state: "loading", agent: config.agent };
      }
    } else {
      // Preflight failed - treat as needing setup
      this.logger.warn("Preflight failed", { error: preflightResult.error.message });
      return { state: "setup", agent: config.agent };
    }
  }

  /**
   * Set the selected agent type.
   *
   * Called after user selects an agent in the selection dialog.
   * Saves selection to config file.
   */
  private async setAgent(payload: SetAgentPayload): Promise<SetupResult> {
    const { agent } = payload;

    // Validate agent value
    if (agent !== "claude" && agent !== "opencode") {
      return {
        success: false,
        message: `Invalid agent type: ${agent}`,
        code: "INVALID_AGENT",
      };
    }

    try {
      await this.deps.configService.setAgent(agent);
      this.logger.info("Agent selection saved", { agent });
      return { success: true };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.logger.warn("Failed to save agent selection", { error: errorMessage });
      return {
        success: false,
        message: errorMessage,
        code: "CONFIG_SAVE_ERROR",
      };
    }
  }

  /**
   * Run the setup process.
   *
   * Behavior:
   * - Uses cached preflight result (from getState()) or runs preflight if not cached
   * - If no setup needed: returns success immediately (no service start)
   * - If setup is already in progress: returns SETUP_IN_PROGRESS error
   * - Otherwise: runs selective setup based on preflight results
   *
   * Note: This method does NOT start services. The renderer must call
   * startServices() after setup() completes successfully.
   */
  private async setup(payload: EmptyPayload): Promise<SetupResult> {
    void payload; // Required by MethodHandler interface but unused for no-arg methods

    // Get setup service for the current agent type (may have changed since getState)
    const vscodeSetup = await this.deps.getVscodeSetup();

    // If no setup service, just return success (no setup to do)
    if (!vscodeSetup) {
      return { success: true };
    }

    // Guard: prevent concurrent setup processes
    if (this.setupInProgress) {
      return {
        success: false,
        message: "Setup already in progress",
        code: "SETUP_IN_PROGRESS",
      };
    }
    this.setupInProgress = true;

    try {
      // Use cached preflight result or run preflight if not available
      // Note: We always run preflight here to get fresh results for the selected agent
      let preflightResult = this.cachedPreflightResult;
      if (!preflightResult) {
        preflightResult = await vscodeSetup.preflight();
      }
      // Clear cache after use
      this.cachedPreflightResult = null;

      // Check if setup is actually needed
      if (preflightResult.success && !preflightResult.needsSetup) {
        // No setup needed - return success (renderer will call startServices)
        return { success: true };
      }

      // Track row states for progress updates
      const rowStates = new Map<SetupRowId, SetupRowProgress>();

      // Determine initial row states based on preflight result
      // If a binary is already installed, mark that row as "done" with appropriate message
      const missingBinaries = preflightResult.success ? preflightResult.missingBinaries : [];
      const needsCodeServer = missingBinaries.includes("code-server");
      const needsAgent = missingBinaries.includes("opencode") || missingBinaries.includes("claude");
      const needsExtensions =
        preflightResult.success &&
        (preflightResult.missingExtensions.length > 0 ||
          preflightResult.outdatedExtensions.length > 0);

      // Set initial states - mark already-installed components as done
      const initialVscodeRow: SetupRowProgress = needsCodeServer
        ? { id: "vscode", status: "pending" }
        : { id: "vscode", status: "done", message: "Already installed" };

      const initialAgentRow: SetupRowProgress = needsAgent
        ? { id: "agent", status: "pending" }
        : { id: "agent", status: "done", message: "Using system CLI" };

      const initialSetupRow: SetupRowProgress = needsExtensions
        ? { id: "setup", status: "pending" }
        : { id: "setup", status: "done", message: "Already configured" };

      // Store initial states
      rowStates.set("vscode", initialVscodeRow);
      rowStates.set("agent", initialAgentRow);
      rowStates.set("setup", initialSetupRow);

      // Emit initial progress state
      this.api.emit("lifecycle:setup-progress", {
        rows: [initialVscodeRow, initialAgentRow, initialSetupRow],
      } satisfies SetupScreenProgress);

      // Track which rows have started to mark them done when complete
      let lastRowId: SetupRowId | null = null;

      // Run setup with progress callbacks and emit IPC events
      // Note: Pass preflight result directly - if preflight failed, setup will handle full install
      const result = await vscodeSetup.setup(preflightResult, (serviceProgress: SetupProgress) => {
        this.logger.debug("Setup progress", {
          step: serviceProgress.step,
          message: serviceProgress.message,
        });

        // Determine which row this progress is for
        const currentRowId = mapStepToRowId(serviceProgress.step, serviceProgress.binaryType);

        // If we're moving to a different row, mark the previous row as done
        if (lastRowId !== null && lastRowId !== currentRowId) {
          rowStates.set(lastRowId, { id: lastRowId, status: "done" });
        }
        lastRowId = currentRowId;

        // Emit row-based progress event via IPC
        const progress = createRowProgress(serviceProgress, rowStates);
        this.api.emit("lifecycle:setup-progress", progress);
      });

      if (result.success) {
        this.logger.info("Setup complete", {});

        // Mark all rows as done
        this.api.emit("lifecycle:setup-progress", {
          rows: [
            { id: "vscode", status: "done" },
            { id: "agent", status: "done" },
            { id: "setup", status: "done" },
          ],
        } satisfies SetupScreenProgress);

        // Return success - renderer will call startServices
        return { success: true };
      } else {
        this.logger.warn("Setup failed", { error: result.error.message });

        // Mark the last active row as failed
        if (lastRowId !== null) {
          rowStates.set(lastRowId, {
            id: lastRowId,
            status: "failed",
            error: result.error.message,
          });
          const rows: SetupRowProgress[] = [];
          for (const id of ["vscode", "agent", "setup"] as SetupRowId[]) {
            const row = rowStates.get(id);
            rows.push(row ?? { id, status: "pending" });
          }
          this.api.emit("lifecycle:setup-progress", { rows });
        }

        return {
          success: false,
          message: result.error.message,
          code: result.error.code ?? result.error.type,
        };
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.logger.warn("Setup failed", { error: errorMessage });
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
   * Start application services (code-server, OpenCode, etc.).
   *
   * Idempotent - second call returns success immediately without side effects.
   * Called by renderer after getState() returns "loading" or after setup() succeeds.
   */
  private async startServices(payload: EmptyPayload): Promise<SetupResult> {
    void payload; // Required by MethodHandler interface but unused for no-arg methods

    // Idempotent guard - second call returns success immediately
    if (this.servicesStarted) {
      return { success: true };
    }
    this.servicesStarted = true;

    try {
      await this.deps.doStartServices();
      this.logger.info("Services started", {});
      return { success: true };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.logger.warn("Service start failed", { error: errorMessage });
      // Reset flag to allow retry
      this.servicesStarted = false;
      return {
        success: false,
        message: errorMessage,
        code: "SERVICE_START_ERROR",
      };
    }
  }

  /**
   * Quit the application.
   */
  private async quit(payload: EmptyPayload): Promise<void> {
    void payload; // Required by MethodHandler interface but unused for no-arg methods
    this.deps.app.quit();
  }

  // ===========================================================================
  // IApiModule Implementation
  // ===========================================================================

  /**
   * Dispose module resources.
   * LifecycleModule has no resources to dispose (IPC handlers cleaned up by ApiRegistry).
   */
  dispose(): void {
    // No resources to dispose
  }
}
