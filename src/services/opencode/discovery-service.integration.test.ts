// @vitest-environment node
/**
 * Integration tests for DiscoveryService wiring.
 * Verifies that DiscoveryService correctly receives and uses
 * the factory-created ProcessTreeProvider.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiscoveryService, type DiscoveryServiceDependencies } from "./discovery-service";
import {
  createProcessTreeProvider,
  PidtreeProvider,
  type ProcessTreeProvider,
} from "../platform/process-tree";
import type { PortManager } from "../platform/network";
import type { InstanceProbe } from "./instance-probe";
import { createSilentLogger } from "../logging";
import { ok, err } from "./types";

describe("DiscoveryService integration with ProcessTreeProvider", () => {
  let discoveryService: DiscoveryService;
  let processTree: ProcessTreeProvider;
  let mockPortManager: PortManager;
  let mockInstanceProbe: InstanceProbe;

  beforeEach(() => {
    // Use the factory to create the provider (platform-appropriate)
    processTree = createProcessTreeProvider(createSilentLogger());

    // Create mock dependencies
    mockPortManager = {
      findFreePort: vi.fn().mockResolvedValue(3000),
      getListeningPorts: vi.fn().mockResolvedValue([]),
    };

    mockInstanceProbe = {
      probe: vi
        .fn()
        .mockResolvedValue(err({ code: "NOT_OPENCODE", message: "Not an OpenCode instance" })),
    };

    const deps: DiscoveryServiceDependencies = {
      portManager: mockPortManager,
      processTree,
      instanceProbe: mockInstanceProbe,
      logger: createSilentLogger(),
    };

    discoveryService = new DiscoveryService(deps);
  });

  afterEach(() => {
    discoveryService.dispose();
    vi.clearAllMocks();
  });

  it("receives the factory-created ProcessTreeProvider", () => {
    // On non-Windows platforms, should be PidtreeProvider
    // On Windows, could be WindowsProcessTreeProvider or fallback PidtreeProvider
    expect(processTree).toBeDefined();
    expect(typeof processTree.getDescendantPids).toBe("function");
  });

  it("factory creates PidtreeProvider on non-Windows platforms", () => {
    // This test verifies the factory selection on the current platform
    if (process.platform !== "win32") {
      expect(processTree).toBeInstanceOf(PidtreeProvider);
    }
  });

  it("scan uses the injected processTree provider", async () => {
    // Set a code-server PID to enable scanning
    discoveryService.setCodeServerPid(process.pid);

    // Mock the port manager to return some ports
    vi.mocked(mockPortManager.getListeningPorts).mockResolvedValue([{ port: 8080, pid: 1234 }]);

    // Scan should complete without error
    const result = await discoveryService.scan();

    // Should succeed (ok result)
    expect(result.ok).toBe(true);

    // Port manager should have been called
    expect(mockPortManager.getListeningPorts).toHaveBeenCalled();
  });

  it("scan filters ports by process tree descendants", async () => {
    // Create a spy on the processTree
    const getDescendantsSpy = vi.spyOn(processTree, "getDescendantPids");

    // Set a code-server PID
    discoveryService.setCodeServerPid(process.pid);

    // Mock port manager to return a port
    vi.mocked(mockPortManager.getListeningPorts).mockResolvedValue([{ port: 8080, pid: 1234 }]);

    await discoveryService.scan();

    // getDescendantPids should have been called with the code-server PID
    expect(getDescendantsSpy).toHaveBeenCalledWith(process.pid);

    getDescendantsSpy.mockRestore();
  });

  it("only probes ports owned by descendant processes", async () => {
    // Create a mock processTree that returns specific descendants
    const mockProcessTree: ProcessTreeProvider = {
      getDescendantPids: vi.fn().mockResolvedValue(new Set([1234, 5678])),
    };

    const deps: DiscoveryServiceDependencies = {
      portManager: mockPortManager,
      processTree: mockProcessTree,
      instanceProbe: mockInstanceProbe,
      logger: createSilentLogger(),
    };

    const service = new DiscoveryService(deps);
    service.setCodeServerPid(1000);

    // Mock port manager to return ports from various PIDs
    vi.mocked(mockPortManager.getListeningPorts).mockResolvedValue([
      { port: 8080, pid: 1234 }, // Descendant - should be probed
      { port: 8081, pid: 9999 }, // Not a descendant - should be skipped
      { port: 8082, pid: 5678 }, // Descendant - should be probed
    ]);

    await service.scan();

    // Should only probe ports 8080 and 8082 (owned by descendants)
    expect(mockInstanceProbe.probe).toHaveBeenCalledTimes(2);
    expect(mockInstanceProbe.probe).toHaveBeenCalledWith(8080);
    expect(mockInstanceProbe.probe).toHaveBeenCalledWith(8082);
    // Should NOT have probed port 8081
    expect(mockInstanceProbe.probe).not.toHaveBeenCalledWith(8081);

    service.dispose();
  });

  it("discovers OpenCode instances and notifies listeners", async () => {
    // Create a mock processTree
    const mockProcessTree: ProcessTreeProvider = {
      getDescendantPids: vi.fn().mockResolvedValue(new Set([1234])),
    };

    // Mock instance probe to identify an OpenCode instance
    const mockProbe: InstanceProbe = {
      probe: vi.fn().mockResolvedValue(ok("/workspace/path")),
    };

    const deps: DiscoveryServiceDependencies = {
      portManager: mockPortManager,
      processTree: mockProcessTree,
      instanceProbe: mockProbe,
      logger: createSilentLogger(),
    };

    const service = new DiscoveryService(deps);
    service.setCodeServerPid(1000);

    // Subscribe to instance changes
    const changedCallback = vi.fn();
    service.onInstancesChanged(changedCallback);

    // Mock port manager
    vi.mocked(mockPortManager.getListeningPorts).mockResolvedValue([{ port: 8080, pid: 1234 }]);

    await service.scan();

    // Should have notified about the discovered instance
    expect(changedCallback).toHaveBeenCalledWith(
      "/workspace/path",
      expect.arrayContaining([expect.objectContaining({ port: 8080 })])
    );

    // Should be able to get instances for the workspace
    const instances = service.getInstancesForWorkspace("/workspace/path");
    expect(instances).toHaveLength(1);
    expect(instances[0]?.port).toBe(8080);

    service.dispose();
  });

  it("clears caches when code-server PID changes", async () => {
    const mockProcessTree: ProcessTreeProvider = {
      getDescendantPids: vi.fn().mockResolvedValue(new Set([1234])),
    };

    const mockProbe: InstanceProbe = {
      probe: vi.fn().mockResolvedValue(ok("/workspace/path")),
    };

    const deps: DiscoveryServiceDependencies = {
      portManager: mockPortManager,
      processTree: mockProcessTree,
      instanceProbe: mockProbe,
      logger: createSilentLogger(),
    };

    const service = new DiscoveryService(deps);

    // First PID
    service.setCodeServerPid(1000);
    vi.mocked(mockPortManager.getListeningPorts).mockResolvedValue([{ port: 8080, pid: 1234 }]);
    await service.scan();

    // Should have instances
    expect(service.getInstancesForWorkspace("/workspace/path")).toHaveLength(1);

    // Change PID - should clear caches
    const changedCallback = vi.fn();
    service.onInstancesChanged(changedCallback);
    service.setCodeServerPid(2000);

    // Should have notified about removed workspace (empty instances)
    expect(changedCallback).toHaveBeenCalledWith("/workspace/path", []);

    // Instances should be cleared
    expect(service.getInstancesForWorkspace("/workspace/path")).toHaveLength(0);

    service.dispose();
  });
});
