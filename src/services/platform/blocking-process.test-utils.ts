/**
 * Test utilities for BlockingProcessService.
 */

import type { BlockingProcessService } from "./blocking-process";
import type { BlockingProcess } from "../../shared/api/types";
import type { Path } from "./path";

/**
 * Options for creating a mock BlockingProcessService.
 */
export interface MockBlockingProcessServiceOptions {
  /**
   * Processes to return from detect().
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
 * Mock BlockingProcessService with configurable behavior.
 */
export interface MockBlockingProcessService extends BlockingProcessService {
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
}

/**
 * Create a mock BlockingProcessService with controllable behavior.
 *
 * @param options - Configuration options for the mock
 * @returns Mock BlockingProcessService
 */
export function createMockBlockingProcessService(
  options: MockBlockingProcessServiceOptions = {}
): MockBlockingProcessService {
  let processes: readonly BlockingProcess[] = options.processes ?? [];

  const mock: MockBlockingProcessService = {
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
      // Ensure cwd field is present on all returned processes
      return processes.map((p) => ({
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
    },

    async closeHandles(path: Path): Promise<void> {
      mock.closeHandlesCalls++;
      mock.lastCloseHandlesPath = path;
      options.onCloseHandles?.(path);
      if (options.closeHandlesUacCancelled) {
        const { UACCancelledError } = await import("./blocking-process");
        throw new UACCancelledError();
      }
      if (options.closeHandlesFails) {
        throw new Error("Failed to close handles");
      }
    },

    setProcesses(newProcesses: readonly BlockingProcess[]): void {
      processes = newProcesses;
    },
  };

  return mock;
}
