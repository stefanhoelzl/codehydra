/**
 * Test utilities for WorkspaceLockHandler.
 */

import type { WorkspaceLockHandler } from "./workspace-lock-handler";
import type { BlockingProcess } from "../../shared/api/types";
import type { Path } from "./path";

/**
 * State tracking interface for behavioral mock assertions.
 *
 * This enables tests to verify that the mock behaves correctly
 * (e.g., detect() returns different results after killProcesses() or closeHandles()).
 */
export interface MockWorkspaceLockHandlerState {
  readonly initialProcesses: readonly BlockingProcess[];
  killedPids: Set<number>;
  handlesClosed: boolean;
}

/**
 * Options for creating a mock WorkspaceLockHandler.
 */
export interface MockWorkspaceLockHandlerOptions {
  /**
   * Initial processes to return from detect().
   * After killProcesses() is called, killed PIDs are filtered out.
   * After closeHandles() succeeds, detect() returns empty array.
   * Default: empty array.
   */
  readonly processes?: readonly BlockingProcess[];
  /**
   * Called when detect() is invoked.
   * Can be used to verify the call was made.
   */
  readonly onDetect?: (path: Path) => void;
  /**
   * Called when killProcesses() is invoked.
   * Can be used to verify the call was made.
   */
  readonly onKillProcesses?: (pids: number[]) => void;
  /**
   * Called when closeHandles() is invoked.
   * Can be used to verify the call was made.
   */
  readonly onCloseHandles?: (path: Path) => void;
  /**
   * If true, killProcesses() will throw an error.
   */
  readonly killFails?: boolean;
  /**
   * If true, closeHandles() will throw a UACCancelledError.
   */
  readonly closeHandlesUacCancelled?: boolean;
  /**
   * If true, closeHandles() will throw a generic error.
   */
  readonly closeHandlesFails?: boolean;
}

/**
 * Mock WorkspaceLockHandler with configurable behavior.
 */
export interface MockWorkspaceLockHandler extends WorkspaceLockHandler {
  /** Number of times detect() was called */
  detectCalls: number;
  /** Number of times killProcesses() was called */
  killProcessesCalls: number;
  /** Number of times closeHandles() was called */
  closeHandlesCalls: number;
  /** Last path passed to detect() */
  lastDetectPath: Path | null;
  /** Last PIDs passed to killProcesses() */
  lastKillPids: number[] | null;
  /** Last path passed to closeHandles() */
  lastCloseHandlesPath: Path | null;
  /** Update the processes to return */
  setProcesses(processes: readonly BlockingProcess[]): void;
  /** Get internal state for test assertions (behavioral mock pattern) */
  _getState(): MockWorkspaceLockHandlerState;
}

/**
 * Create a mock WorkspaceLockHandler with controllable behavior.
 *
 * The mock simulates behavioral state changes:
 * - `detect()` returns different results after `killProcesses()` (killed PIDs filtered out)
 * - `detect()` returns empty after `closeHandles()` succeeds
 *
 * @param options - Configuration options for the mock
 * @returns Mock WorkspaceLockHandler with state tracking
 */
export function createMockWorkspaceLockHandler(
  options: MockWorkspaceLockHandlerOptions = {}
): MockWorkspaceLockHandler {
  const initialProcesses: readonly BlockingProcess[] = options.processes ?? [];

  // State tracking for behavioral simulation
  const state: MockWorkspaceLockHandlerState = {
    initialProcesses,
    killedPids: new Set<number>(),
    handlesClosed: false,
  };

  const mock: MockWorkspaceLockHandler = {
    detectCalls: 0,
    killProcessesCalls: 0,
    closeHandlesCalls: 0,
    lastDetectPath: null,
    lastKillPids: null,
    lastCloseHandlesPath: null,

    async detect(path: Path): Promise<BlockingProcess[]> {
      mock.detectCalls++;
      mock.lastDetectPath = path;
      options.onDetect?.(path);

      // Behavioral simulation: return different results based on state
      if (state.handlesClosed) {
        // After closeHandles() succeeds, no processes block anymore
        return [];
      }

      // Filter out killed PIDs
      return state.initialProcesses
        .filter((p) => !state.killedPids.has(p.pid))
        .map((p) => ({
          ...p,
          cwd: p.cwd ?? null,
        }));
    },

    async detectCwd(path: Path): Promise<BlockingProcess[]> {
      mock.detectCalls++;
      mock.lastDetectPath = path;
      options.onDetect?.(path);

      // Same behavioral simulation as detect, but only returns processes with a CWD
      if (state.handlesClosed) {
        return [];
      }

      return state.initialProcesses
        .filter((p) => !state.killedPids.has(p.pid) && p.cwd !== null)
        .map((p) => ({
          ...p,
          cwd: p.cwd ?? null,
        }));
    },

    async killProcesses(pids: number[]): Promise<void> {
      mock.killProcessesCalls++;
      mock.lastKillPids = pids;
      options.onKillProcesses?.(pids);
      if (options.killFails) {
        throw new Error("Failed to kill processes");
      }
      // Track killed PIDs for behavioral simulation
      for (const pid of pids) {
        state.killedPids.add(pid);
      }
    },

    async closeHandles(path: Path): Promise<void> {
      mock.closeHandlesCalls++;
      mock.lastCloseHandlesPath = path;
      options.onCloseHandles?.(path);
      if (options.closeHandlesUacCancelled) {
        const { UACCancelledError } = await import("./workspace-lock-handler");
        throw new UACCancelledError();
      }
      if (options.closeHandlesFails) {
        throw new Error("Failed to close handles");
      }
      // Track handles closed for behavioral simulation
      state.handlesClosed = true;
    },

    setProcesses(newProcesses: readonly BlockingProcess[]): void {
      // Update initialProcesses for backward compatibility
      // This also resets the state since we're starting fresh
      (state as { initialProcesses: readonly BlockingProcess[] }).initialProcesses = newProcesses;
      state.killedPids.clear();
      state.handlesClosed = false;
    },

    _getState(): MockWorkspaceLockHandlerState {
      return state;
    },
  };

  return mock;
}
