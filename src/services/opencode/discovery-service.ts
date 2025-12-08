/**
 * Discovery service for finding OpenCode instances.
 * Scans for listening ports, filters by code-server process tree,
 * and probes to identify OpenCode instances.
 */

import type { PortScanner } from "./port-scanner";
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
} from "./types";

/**
 * Dependencies for DiscoveryService.
 */
export interface DiscoveryServiceDependencies {
  readonly portScanner: PortScanner;
  readonly processTree: ProcessTreeProvider;
  readonly instanceProbe: InstanceProbe;
}

/**
 * Callback for instance changes.
 */
export type InstancesChangedCallback = (workspacePath: string, ports: Set<number>) => void;

/**
 * TTL for non-OpenCode port cache (5 minutes).
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Discovery service for finding OpenCode instances.
 * Regular class with constructor DI - NOT a singleton.
 */
export class DiscoveryService implements IDisposable {
  private readonly portScanner: PortScanner;
  private readonly processTree: ProcessTreeProvider;
  private readonly instanceProbe: InstanceProbe;

  private codeServerPid: number | null = null;
  private readonly activeInstances = new Map<string, Set<number>>();
  private readonly knownPorts = new Map<number, string>();
  private readonly nonOpenCodePorts = new Map<number, NonOpenCodePortEntry>();
  private scanning = false;
  private readonly listeners = new Set<InstancesChangedCallback>();

  constructor(deps: DiscoveryServiceDependencies) {
    this.portScanner = deps.portScanner;
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
   */
  getPortsForWorkspace(workspacePath: string): Set<number> {
    return this.activeInstances.get(workspacePath) ?? new Set();
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

      // Scan for listening ports
      const portsResult = await this.portScanner.scan();
      if (!portsResult.ok) {
        return err({
          code: "PORT_SCAN_FAILED",
          message: portsResult.error.message,
          cause: portsResult.error,
        });
      }

      // Filter ports by descendant PIDs
      const candidatePorts = portsResult.value.filter((p) => descendants.has(p.pid));

      // Track current scan's discovered ports
      const currentPorts = new Map<string, Set<number>>();

      // Probe each candidate port
      for (const { port, pid } of candidatePorts) {
        // Skip if we already know this port
        if (this.knownPorts.has(port)) {
          const workspace = this.knownPorts.get(port)!;
          if (!currentPorts.has(workspace)) {
            currentPorts.set(workspace, new Set());
          }
          currentPorts.get(workspace)!.add(port);
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
          this.knownPorts.set(port, workspace);

          if (!currentPorts.has(workspace)) {
            currentPorts.set(workspace, new Set());
          }
          currentPorts.get(workspace)!.add(port);

          // Remove from non-OpenCode cache if it was there
          this.nonOpenCodePorts.delete(port);
        } else {
          // Cache as non-OpenCode port
          this.nonOpenCodePorts.set(port, { pid, timestamp: Date.now() });
        }
      }

      // Update active instances and notify changes
      this.updateActiveInstances(currentPorts);

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
      this.notifyListeners(workspace, new Set());
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

  private updateActiveInstances(currentPorts: Map<string, Set<number>>): void {
    // Check for removed or changed workspaces
    for (const [workspace, oldPorts] of this.activeInstances) {
      const newPorts = currentPorts.get(workspace) ?? new Set();
      const changed =
        oldPorts.size !== newPorts.size || [...oldPorts].some((p) => !newPorts.has(p));

      if (changed) {
        if (newPorts.size === 0) {
          this.activeInstances.delete(workspace);
          // Clean up known ports for this workspace
          for (const [port, ws] of this.knownPorts) {
            if (ws === workspace) {
              this.knownPorts.delete(port);
            }
          }
        } else {
          this.activeInstances.set(workspace, newPorts);
        }
        this.notifyListeners(workspace, newPorts);
      }
    }

    // Check for new workspaces
    for (const [workspace, ports] of currentPorts) {
      if (!this.activeInstances.has(workspace)) {
        this.activeInstances.set(workspace, ports);
        this.notifyListeners(workspace, ports);
      }
    }
  }

  private notifyListeners(workspace: string, ports: Set<number>): void {
    for (const listener of this.listeners) {
      listener(workspace, ports);
    }
  }
}
