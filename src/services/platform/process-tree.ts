/**
 * Process tree provider using pidtree.
 * Gets descendant PIDs for a given parent process.
 */

import pidtree from "pidtree";
import type { Logger } from "../logging";

/**
 * Interface for process tree operations.
 * Abstracts the underlying implementation for testability.
 */
export interface ProcessTreeProvider {
  /**
   * Get all descendant PIDs of a process.
   * @param pid Parent process ID
   * @returns Set of descendant PIDs (empty on error)
   */
  getDescendantPids(pid: number): Promise<Set<number>>;
}

/**
 * Process tree provider implementation using pidtree.
 */
export class PidtreeProvider implements ProcessTreeProvider {
  constructor(private readonly logger: Logger) {}

  async getDescendantPids(pid: number): Promise<Set<number>> {
    try {
      const descendants = await pidtree(pid);
      this.logger.silly("GetDescendants", { pid, count: descendants.length });
      return new Set(descendants);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.warn("GetDescendants failed", { pid, error: errMsg });
      // Return empty set on error (process may have exited)
      return new Set();
    }
  }
}
