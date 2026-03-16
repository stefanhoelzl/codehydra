/**
 * Test utilities for IpcBoundary mocking.
 *
 * Provides a behavioral mock for IpcBoundary that tracks handler registrations
 * and allows state inspection for testing.
 */

import type { IpcBoundary, IpcHandler, IpcEventHandler } from "./ipc";
import { PlatformError } from "../../shared/errors/platform-errors";

/**
 * State exposed by the behavioral mock for test inspection.
 */
export interface IpcBoundaryState {
  /** Map of channel names to registered handlers */
  readonly handlers: Map<string, IpcHandler>;
}

/**
 * Behavioral mock for IpcBoundary.
 * Extends IpcBoundary with a _getState() method for test inspection.
 */
export interface BehavioralIpcBoundary extends IpcBoundary {
  /** Get the current state for test assertions */
  _getState(): IpcBoundaryState;

  /**
   * Simulate invoking a handler (for testing handler behavior).
   * This is NOT part of the real IpcBoundary interface - it's a test helper.
   *
   * @param channel - The IPC channel name
   * @param args - Arguments to pass to the handler
   * @returns The handler's return value
   * @throws PlatformError with code IPC_HANDLER_NOT_FOUND if no handler registered
   */
  _invoke(channel: string, ...args: unknown[]): unknown;

  /**
   * Simulate sending a fire-and-forget event (for testing event listeners).
   * This is NOT part of the real IpcBoundary interface - it's a test helper.
   *
   * @param channel - The IPC channel name
   * @param args - Arguments to pass to the listeners
   */
  _emit(channel: string, ...args: unknown[]): void;

  /**
   * Get registered event listeners for a channel (for test inspection).
   *
   * @param channel - The IPC channel name
   * @returns Array of registered listeners
   */
  _getListeners(channel: string): readonly IpcEventHandler[];
}

/**
 * Create a behavioral mock for IpcBoundary.
 *
 * This mock tracks handler registrations in memory and provides:
 * - Error behavior matching the real implementation (duplicate throws)
 * - State inspection via _getState() for assertions
 * - Handler invocation via _invoke() for testing handler logic
 *
 * @example Basic usage
 * ```typescript
 * const ipcLayer = createBehavioralIpcBoundary();
 * ipcLayer.handle("api:test", async () => "result");
 *
 * const state = ipcLayer._getState();
 * expect(state.handlers.has("api:test")).toBe(true);
 * ```
 *
 * @example Testing duplicate registration error
 * ```typescript
 * const ipcLayer = createBehavioralIpcBoundary();
 * ipcLayer.handle("api:test", async () => "result");
 *
 * expect(() => ipcLayer.handle("api:test", async () => "other"))
 *   .toThrow(PlatformError);
 * ```
 */
export function createBehavioralIpcBoundary(): BehavioralIpcBoundary {
  const handlers = new Map<string, IpcHandler>();
  const eventListeners = new Map<string, IpcEventHandler[]>();

  return {
    handle(channel: string, handler: IpcHandler): void {
      if (handlers.has(channel)) {
        throw new PlatformError(
          "IPC_HANDLER_EXISTS",
          `Handler already exists for channel: ${channel}`
        );
      }
      handlers.set(channel, handler);
    },

    removeHandler(channel: string): void {
      if (!handlers.has(channel)) {
        throw new PlatformError(
          "IPC_HANDLER_NOT_FOUND",
          `No handler registered for channel: ${channel}`
        );
      }
      handlers.delete(channel);
    },

    removeAllHandlers(): void {
      handlers.clear();
    },

    on(channel: string, listener: IpcEventHandler): void {
      const listeners = eventListeners.get(channel) ?? [];
      listeners.push(listener);
      eventListeners.set(channel, listeners);
    },

    removeListener(channel: string, listener: IpcEventHandler): void {
      const listeners = eventListeners.get(channel);
      if (listeners) {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
        if (listeners.length === 0) {
          eventListeners.delete(channel);
        }
      }
    },

    _getState(): IpcBoundaryState {
      return {
        handlers: new Map(handlers),
      };
    },

    _invoke(channel: string, ...args: unknown[]): unknown {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new PlatformError(
          "IPC_HANDLER_NOT_FOUND",
          `No handler registered for channel: ${channel}`
        );
      }
      // Create a minimal mock event object for testing
      const mockEvent = {} as Parameters<IpcHandler>[0];
      return handler(mockEvent, ...args);
    },

    _emit(channel: string, ...args: unknown[]): void {
      const listeners = eventListeners.get(channel);
      if (listeners) {
        const mockEvent = {} as Parameters<IpcEventHandler>[0];
        for (const listener of [...listeners]) {
          listener(mockEvent, ...args);
        }
      }
    },

    _getListeners(channel: string): readonly IpcEventHandler[] {
      return eventListeners.get(channel) ?? [];
    },
  };
}
