/**
 * Test utilities for IpcBoundary mocking.
 *
 * Provides a behavioral mock for IpcBoundary that tracks event-listener
 * registrations and allows state inspection for testing.
 */

import type { IpcBoundary, IpcEventHandler } from "./ipc";

/**
 * Behavioral mock for IpcBoundary.
 * Extends IpcBoundary with test helpers for inspecting and driving listeners.
 */
export interface BehavioralIpcBoundary extends IpcBoundary {
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
 * This mock tracks event-listener registrations in memory and provides:
 * - Listener inspection via _getListeners() for assertions
 * - Listener invocation via _emit() for testing handler logic
 *
 * @example Basic usage
 * ```typescript
 * const ipcLayer = createBehavioralIpcBoundary();
 * const listener = (_event, payload) => { ... };
 * ipcLayer.on("api:ui:event", listener);
 *
 * expect(ipcLayer._getListeners("api:ui:event")).toHaveLength(1);
 * ipcLayer._emit("api:ui:event", { kind: "ui-connected" });
 * ```
 */
export function createBehavioralIpcBoundary(): BehavioralIpcBoundary {
  const eventListeners = new Map<string, IpcEventHandler[]>();

  return {
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
