/**
 * Discovery service for finding OpenCode instances.
 * Scans for listening ports, filters by code-server process tree,
 * and probes to identify OpenCode instances.
 */

import type { PortManager } from "../platform/network";
import type { ProcessTreeProvider } from "./process-tree";
import type { InstanceProbe } from "./instance-probe";
import {
  ok,
  err,
  type Result,
  type DiscoveryError,
  type IDisposable,
  type Unsubscribe,
  type NonOpenCodePortEntry,
  type DiscoveredInstance,
} from "./types";

/**
 * Dependencies for DiscoveryService.
 */
export interface DiscoveryServiceDependencies {
  readonly portManager: PortManager;
  readonly processTree: ProcessTreeProvider;
  readonly instanceProbe: InstanceProbe;
}

/**
 * Callback for instance changes.
 * Receives discovered instances (port only - PID is internal).
 */
export type InstancesChangedCallback = (
  workspacePath: string,
  instances: ReadonlyArray<DiscoveredInstance>
) => void;

/**
 * TTL for non-OpenCode port cache (5 minutes).
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Discovery service for finding OpenCode instances.
 * Regular class with constructor DI - NOT a singleton.
 */
export class DiscoveryService implements IDisposable {
  private readonly portManager: PortManager;
  private readonly processTree: ProcessTreeProvider;
  private readonly instanceProbe: InstanceProbe;

  private codeServerPid: number | null = null;
  private readonly activeInstances = new Map<string, DiscoveredInstance[]>();
  private readonly knownPorts = new Map<number, { workspace: string; pid: number }>();
  private readonly nonOpenCodePorts = new Map<number, NonOpenCodePortEntry>();
  private scanning = false;
  private readonly listeners = new Set<InstancesChangedCallback>();

  constructor(deps: DiscoveryServiceDependencies) {
    this.portManager = deps.portManager;
    this.processTree = deps.processTree;
    this.instanceProbe = deps.instanceProbe;
  }

  /**
   * Set the code-server PID. Clears caches when PID changes.
   */
  setCodeServerPid(pid: number | null): void {
    if (this.codeServerPid !== pid) {
      this.codeServerPid = pid;
      this.clearCaches();
    }
  }

  /**
   * Get ports associated with a workspace.
   * @deprecated Use getInstancesForWorkspace for PID tracking.
   */
  getPortsForWorkspace(workspacePath: string): Set<number> {
    const instances = this.activeInstances.get(workspacePath);
    if (!instances) {
      return new Set();
    }
    return new Set(instances.map((i) => i.port));
  }

  /**
   * Get discovered instances for a workspace.
   * Includes port and PID for each instance.
   */
  getInstancesForWorkspace(workspacePath: string): ReadonlyArray<DiscoveredInstance> {
    return this.activeInstances.get(workspacePath) ?? [];
  }

  /**
   * Subscribe to instance changes.
   */
  onInstancesChanged(callback: InstancesChangedCallback): Unsubscribe {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Scan for OpenCode instances.
   */
  async scan(): Promise<Result<void, DiscoveryError>> {
    // Skip if no code-server PID
    if (this.codeServerPid === null) {
      return ok(undefined);
    }

    // Prevent concurrent scans
    if (this.scanning) {
      return err({
        code: "SCAN_IN_PROGRESS",
        message: "A scan is already in progress",
      });
    }

    this.scanning = true;

    try {
      // Clean up expired cache entries
      this.cleanupExpiredCache();

      // Get descendant PIDs once
      const descendants = await this.processTree.getDescendantPids(this.codeServerPid);

      // Scan for listening ports using PortManager
      let listeningPorts: readonly { port: number; pid: number }[];
      try {
        listeningPorts = await this.portManager.getListeningPorts();
      } catch (error) {
        return err({
          code: "PORT_SCAN_FAILED",
          message: error instanceof Error ? error.message : "Unknown error",
          cause: error,
        });
      }

      // Filter ports by descendant PIDs
      const candidatePorts = listeningPorts.filter((p) => descendants.has(p.pid));

      // Track current scan's discovered instances per workspace
      const currentInstances = new Map<string, DiscoveredInstance[]>();

      // Probe each candidate port
      for (const { port, pid } of candidatePorts) {
        // Skip if we already know this port
        const known = this.knownPorts.get(port);
        if (known) {
          const workspace = known.workspace;
          if (!currentInstances.has(workspace)) {
            currentInstances.set(workspace, []);
          }
          currentInstances.get(workspace)!.push({ port });
          continue;
        }

        // Check if it's a known non-OpenCode port
        const cachedNonOpenCode = this.nonOpenCodePorts.get(port);
        if (cachedNonOpenCode && cachedNonOpenCode.pid === pid) {
          // Same PID, skip probing
          continue;
        }

        // Probe the port
        const probeResult = await this.instanceProbe.probe(port);

        if (probeResult.ok) {
          const workspace = probeResult.value;
          this.knownPorts.set(port, { workspace, pid });

          if (!currentInstances.has(workspace)) {
            currentInstances.set(workspace, []);
          }
          currentInstances.get(workspace)!.push({ port });

          // Remove from non-OpenCode cache if it was there
          this.nonOpenCodePorts.delete(port);
        } else {
          // Cache as non-OpenCode port
          this.nonOpenCodePorts.set(port, { pid, timestamp: Date.now() });
        }
      }

      // Update active instances and notify changes
      this.updateActiveInstances(currentInstances);

      return ok(undefined);
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Dispose the service.
   */
  dispose(): void {
    this.clearCaches();
    this.listeners.clear();
    this.codeServerPid = null;
  }

  private clearCaches(): void {
    // Notify listeners about removed workspaces
    for (const [workspace] of this.activeInstances) {
      this.notifyListeners(workspace, []);
    }

    this.activeInstances.clear();
    this.knownPorts.clear();
    this.nonOpenCodePorts.clear();
  }

  private cleanupExpiredCache(): void {
    const now = Date.now();
    for (const [port, entry] of this.nonOpenCodePorts) {
      if (now - entry.timestamp > CACHE_TTL_MS) {
        this.nonOpenCodePorts.delete(port);
      }
    }
  }

  private updateActiveInstances(currentInstances: Map<string, DiscoveredInstance[]>): void {
    // Check for removed or changed workspaces
    for (const [workspace, oldInstances] of this.activeInstances) {
      const newInstances = currentInstances.get(workspace) ?? [];
      const changed = this.instancesChanged(oldInstances, newInstances);

      if (changed) {
        if (newInstances.length === 0) {
          this.activeInstances.delete(workspace);
          // Clean up known ports for this workspace
          for (const [port, info] of this.knownPorts) {
            if (info.workspace === workspace) {
              this.knownPorts.delete(port);
            }
          }
        } else {
          this.activeInstances.set(workspace, newInstances);
        }
        this.notifyListeners(workspace, newInstances);
      }
    }

    // Check for new workspaces
    for (const [workspace, instances] of currentInstances) {
      if (!this.activeInstances.has(workspace)) {
        this.activeInstances.set(workspace, instances);
        this.notifyListeners(workspace, instances);
      }
    }
  }

  /**
   * Check if two instance arrays represent a change.
   * Compares by port (PIDs may change due to process restart).
   */
  private instancesChanged(
    oldInstances: DiscoveredInstance[],
    newInstances: DiscoveredInstance[]
  ): boolean {
    if (oldInstances.length !== newInstances.length) {
      return true;
    }
    const oldPorts = new Set(oldInstances.map((i) => i.port));
    return newInstances.some((i) => !oldPorts.has(i.port));
  }

  private notifyListeners(workspace: string, instances: ReadonlyArray<DiscoveredInstance>): void {
    for (const listener of this.listeners) {
      listener(workspace, instances);
    }
  }
}
