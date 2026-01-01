/**
 * IpcLayer - Abstraction over Electron IPC handler registration.
 *
 * Provides an injectable interface for IPC handler management, enabling:
 * - Unit testing of API registries with behavioral mocks
 * - Boundary testing of DefaultIpcLayer against real ipcMain
 * - Consistent error handling via PlatformError
 *
 * Note: This layer only handles ipcMain.handle() registration.
 * Sending messages to renderer is done via ViewLayer's webContents access.
 */

import type { IpcMainInvokeEvent } from "electron";
import { PlatformError } from "./errors";

/**
 * Handler function type for IPC invoke handlers.
 */
export type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/**
 * Abstraction over IPC handler registration.
 *
 * Methods throw PlatformError on failures:
 * - `IPC_HANDLER_EXISTS` when registering a handler for an already-registered channel
 * - `IPC_HANDLER_NOT_FOUND` when removing a handler that doesn't exist
 */
export interface IpcLayer {
  /**
   * Register a handler for an IPC invoke channel.
   *
   * @param channel - The IPC channel name
   * @param handler - The handler function
   * @throws PlatformError with code IPC_HANDLER_EXISTS if handler already registered
   */
  handle(channel: string, handler: IpcHandler): void;

  /**
   * Remove a handler for an IPC invoke channel.
   *
   * @param channel - The IPC channel name
   * @throws PlatformError with code IPC_HANDLER_NOT_FOUND if no handler registered
   */
  removeHandler(channel: string): void;

  /**
   * Remove all registered handlers.
   * This is useful for cleanup during shutdown.
   */
  removeAllHandlers(): void;
}

// ============================================================================
// Default Implementation
// ============================================================================

import { ipcMain } from "electron";
import type { Logger } from "../logging";

/**
 * Default implementation of IpcLayer using Electron's ipcMain.
 *
 * Tracks registered channels to detect duplicate registrations
 * (which ipcMain silently ignores) and provide better error messages.
 */
export class DefaultIpcLayer implements IpcLayer {
  private readonly registeredChannels = new Set<string>();

  constructor(private readonly logger: Logger) {}

  handle(channel: string, handler: IpcHandler): void {
    if (this.registeredChannels.has(channel)) {
      throw new PlatformError(
        "IPC_HANDLER_EXISTS",
        `Handler already exists for channel: ${channel}`
      );
    }

    ipcMain.handle(channel, handler);
    this.registeredChannels.add(channel);
    this.logger.debug("IPC handler registered", { channel });
  }

  removeHandler(channel: string): void {
    if (!this.registeredChannels.has(channel)) {
      throw new PlatformError(
        "IPC_HANDLER_NOT_FOUND",
        `No handler registered for channel: ${channel}`
      );
    }

    ipcMain.removeHandler(channel);
    this.registeredChannels.delete(channel);
    this.logger.debug("IPC handler removed", { channel });
  }

  removeAllHandlers(): void {
    for (const channel of this.registeredChannels) {
      ipcMain.removeHandler(channel);
      this.logger.debug("IPC handler removed", { channel });
    }
    this.registeredChannels.clear();
  }
}
