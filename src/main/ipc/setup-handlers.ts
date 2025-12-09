/**
 * IPC handlers for VS Code setup flow.
 */

import type { IpcMainInvokeEvent } from "electron";
import type { SetupProgress, SetupErrorPayload, SetupReadyResponse } from "../../shared/ipc";
import type { IVscodeSetup } from "../../services/vscode-setup";

/**
 * Callbacks for emitting setup events to the renderer.
 */
export interface SetupEventEmitters {
  /** Emit progress update */
  emitProgress: (progress: SetupProgress) => void;
  /**
   * Emit setup complete.
   * IMPORTANT: This is async because it must wait for services to start
   * before emitting the complete event to the renderer.
   */
  emitComplete: () => void | Promise<void>;
  /** Emit setup error */
  emitError: (error: SetupErrorPayload) => void;
}

/**
 * Creates handler for setup:ready command.
 * Only checks if setup is complete and returns status.
 * Does NOT run cleanup or setup - those are handled separately in the main process.
 *
 * @param setupService - The VS Code setup service
 * @returns Handler that returns { ready: true } if setup complete, { ready: false } if needed
 */
export function createSetupReadyHandler(
  setupService: IVscodeSetup
): (event: IpcMainInvokeEvent, payload: void) => Promise<SetupReadyResponse> {
  return async () => {
    const isComplete = await setupService.isSetupComplete();
    return { ready: isComplete };
  };
}

/**
 * Creates handler for starting the setup process.
 * This is called internally after setup:ready returns { ready: false }.
 *
 * @param setupService - The VS Code setup service
 * @param emitters - Event emitters for progress/complete/error
 * @returns Handler that runs the setup process
 */
export function createSetupStartHandler(
  setupService: IVscodeSetup,
  emitters: SetupEventEmitters
): (event: IpcMainInvokeEvent, payload: void) => Promise<void> {
  return async () => {
    try {
      const result = await setupService.setup((progress) => {
        emitters.emitProgress(progress);
      });

      if (result.success) {
        await emitters.emitComplete();
      } else {
        emitters.emitError({
          message: result.error.message,
          code: result.error.code ?? result.error.type,
        });
      }
    } catch (error) {
      emitters.emitError({
        message: error instanceof Error ? error.message : String(error),
        code: "unknown",
      });
    }
  };
}

/**
 * Creates handler for setup:retry command.
 * Cleans vscode directory and re-runs setup.
 */
export function createSetupRetryHandler(
  setupService: IVscodeSetup,
  emitters: SetupEventEmitters
): (event: IpcMainInvokeEvent, payload: void) => Promise<void> {
  return async () => {
    try {
      // Clean vscode directory first
      await setupService.cleanVscodeDir();

      // Re-run setup
      const result = await setupService.setup((progress) => {
        emitters.emitProgress(progress);
      });

      if (result.success) {
        await emitters.emitComplete();
      } else {
        emitters.emitError({
          message: result.error.message,
          code: result.error.code ?? result.error.type,
        });
      }
    } catch (error) {
      emitters.emitError({
        message: error instanceof Error ? error.message : String(error),
        code: "unknown",
      });
    }
  };
}

/**
 * Creates handler for setup:quit command.
 * Quits the application.
 */
export function createSetupQuitHandler(
  quitFn: () => void
): (event: IpcMainInvokeEvent, payload: void) => Promise<void> {
  return async () => {
    quitFn();
  };
}
