/**
 * Process tree provider using pidtree.
 * Gets descendant PIDs for a given parent process.
 */

import pidtree from "pidtree";

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
  async getDescendantPids(pid: number): Promise<Set<number>> {
    try {
      const descendants = await pidtree(pid);
      return new Set(descendants);
    } catch {
      // Return empty set on error (process may have exited)
      return new Set();
    }
  }
}
