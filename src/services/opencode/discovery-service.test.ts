// @vitest-environment node
/**
 * Tests for DiscoveryService.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiscoveryService, type DiscoveryServiceDependencies } from "./discovery-service";
import type { PortScanner } from "./port-scanner";
import type { ProcessTreeProvider } from "./process-tree";
import type { InstanceProbe } from "./instance-probe";
import { ok, err } from "./types";

describe("DiscoveryService", () => {
  let service: DiscoveryService;
  let mockPortScanner: PortScanner;
  let mockProcessTree: ProcessTreeProvider;
  let mockInstanceProbe: InstanceProbe;

  beforeEach(() => {
    vi.useFakeTimers();

    mockPortScanner = {
      scan: vi.fn().mockResolvedValue(ok([])),
    };

    mockProcessTree = {
      getDescendantPids: vi.fn().mockResolvedValue(new Set<number>()),
    };

    mockInstanceProbe = {
      probe: vi.fn().mockResolvedValue(ok("/test/workspace")),
    };

    const deps: DiscoveryServiceDependencies = {
      portScanner: mockPortScanner,
      processTree: mockProcessTree,
      instanceProbe: mockInstanceProbe,
    };

    service = new DiscoveryService(deps);
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  describe("setCodeServerPid", () => {
    it("updates the code-server PID", () => {
      service.setCodeServerPid(1234);

      // Should clear caches when PID changes - verified by subsequent scan behavior
      expect(service.getPortsForWorkspace("/any")).toEqual(new Set());
    });

    it("clears known ports when PID changes", async () => {
      // Setup: discover a port first
      service.setCodeServerPid(1000);
      vi.mocked(mockProcessTree.getDescendantPids).mockResolvedValue(new Set([2000]));
      vi.mocked(mockPortScanner.scan).mockResolvedValue(ok([{ port: 8080, pid: 2000 }]));
      vi.mocked(mockInstanceProbe.probe).mockResolvedValue(ok("/workspace/a"));

      await service.scan();
      expect(service.getPortsForWorkspace("/workspace/a").size).toBe(1);

      // Now change PID - should clear caches
      service.setCodeServerPid(3000);
      expect(service.getPortsForWorkspace("/workspace/a").size).toBe(0);
    });

    it("can be set to null", () => {
      service.setCodeServerPid(1234);
      service.setCodeServerPid(null);

      // Should not throw and subsequent scans should skip
      expect(service.getPortsForWorkspace("/any")).toEqual(new Set());
    });
  });

  describe("getPortsForWorkspace", () => {
    it("returns empty set for unknown workspace", () => {
      const ports = service.getPortsForWorkspace("/unknown/workspace");

      expect(ports).toBeInstanceOf(Set);
      expect(ports.size).toBe(0);
    });

    it("returns ports for known workspace", async () => {
      service.setCodeServerPid(1000);
      vi.mocked(mockProcessTree.getDescendantPids).mockResolvedValue(new Set([2000, 3000]));
      vi.mocked(mockPortScanner.scan).mockResolvedValue(
        ok([
          { port: 8080, pid: 2000 },
          { port: 9090, pid: 3000 },
        ])
      );
      vi.mocked(mockInstanceProbe.probe)
        .mockResolvedValueOnce(ok("/workspace/a"))
        .mockResolvedValueOnce(ok("/workspace/a"));

      await service.scan();

      const ports = service.getPortsForWorkspace("/workspace/a");
      expect(ports.size).toBe(2);
      expect(ports.has(8080)).toBe(true);
      expect(ports.has(9090)).toBe(true);
    });
  });

  describe("onInstancesChanged", () => {
    it("notifies listeners when instances change", async () => {
      const listener = vi.fn();
      service.onInstancesChanged(listener);

      service.setCodeServerPid(1000);
      vi.mocked(mockProcessTree.getDescendantPids).mockResolvedValue(new Set([2000]));
      vi.mocked(mockPortScanner.scan).mockResolvedValue(ok([{ port: 8080, pid: 2000 }]));
      vi.mocked(mockInstanceProbe.probe).mockResolvedValue(ok("/workspace/a"));

      await service.scan();

      expect(listener).toHaveBeenCalledWith("/workspace/a", new Set([8080]));
    });

    it("returns unsubscribe function", async () => {
      const listener = vi.fn();
      const unsubscribe = service.onInstancesChanged(listener);

      unsubscribe();

      service.setCodeServerPid(1000);
      vi.mocked(mockProcessTree.getDescendantPids).mockResolvedValue(new Set([2000]));
      vi.mocked(mockPortScanner.scan).mockResolvedValue(ok([{ port: 8080, pid: 2000 }]));
      vi.mocked(mockInstanceProbe.probe).mockResolvedValue(ok("/workspace/a"));

      await service.scan();

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("dispose", () => {
    it("clears all state", () => {
      service.setCodeServerPid(1234);
      service.dispose();

      expect(service.getPortsForWorkspace("/any")).toEqual(new Set());
    });
  });
});

describe("DiscoveryService scan", () => {
  let service: DiscoveryService;
  let mockPortScanner: PortScanner;
  let mockProcessTree: ProcessTreeProvider;
  let mockInstanceProbe: InstanceProbe;

  beforeEach(() => {
    vi.useFakeTimers();

    mockPortScanner = {
      scan: vi.fn().mockResolvedValue(ok([])),
    };

    mockProcessTree = {
      getDescendantPids: vi.fn().mockResolvedValue(new Set<number>()),
    };

    mockInstanceProbe = {
      probe: vi.fn().mockResolvedValue(ok("/test/workspace")),
    };

    service = new DiscoveryService({
      portScanner: mockPortScanner,
      processTree: mockProcessTree,
      instanceProbe: mockInstanceProbe,
    });
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("skips scan when no code-server PID", async () => {
    const result = await service.scan();

    expect(result.ok).toBe(true);
    expect(mockPortScanner.scan).not.toHaveBeenCalled();
  });

  it("scans ports and filters by descendant PIDs", async () => {
    service.setCodeServerPid(1000);
    vi.mocked(mockProcessTree.getDescendantPids).mockResolvedValue(new Set([2000, 3000]));
    vi.mocked(mockPortScanner.scan).mockResolvedValue(
      ok([
        { port: 8080, pid: 2000 }, // descendant - should probe
        { port: 9090, pid: 4000 }, // not descendant - should skip
      ])
    );

    await service.scan();

    // Should only probe descendant port
    expect(mockInstanceProbe.probe).toHaveBeenCalledTimes(1);
    expect(mockInstanceProbe.probe).toHaveBeenCalledWith(8080);
  });

  it("caches non-OpenCode ports to avoid re-probing", async () => {
    service.setCodeServerPid(1000);
    vi.mocked(mockProcessTree.getDescendantPids).mockResolvedValue(new Set([2000]));
    vi.mocked(mockPortScanner.scan).mockResolvedValue(ok([{ port: 8080, pid: 2000 }]));
    vi.mocked(mockInstanceProbe.probe).mockResolvedValue(
      err({ code: "NOT_OPENCODE", message: "Not an OpenCode instance" })
    );

    // First scan - should probe
    await service.scan();
    expect(mockInstanceProbe.probe).toHaveBeenCalledTimes(1);

    // Second scan - should skip (cached)
    await service.scan();
    expect(mockInstanceProbe.probe).toHaveBeenCalledTimes(1);
  });

  it("re-probes if port PID changes (port reuse)", async () => {
    service.setCodeServerPid(1000);

    // First scan: port 8080 with PID 2000 (not OpenCode)
    vi.mocked(mockProcessTree.getDescendantPids).mockResolvedValue(new Set([2000]));
    vi.mocked(mockPortScanner.scan).mockResolvedValue(ok([{ port: 8080, pid: 2000 }]));
    vi.mocked(mockInstanceProbe.probe).mockResolvedValue(
      err({ code: "NOT_OPENCODE", message: "Not an OpenCode instance" })
    );

    await service.scan();
    expect(mockInstanceProbe.probe).toHaveBeenCalledTimes(1);

    // Second scan: same port but different PID (port was reused)
    vi.mocked(mockProcessTree.getDescendantPids).mockResolvedValue(new Set([3000]));
    vi.mocked(mockPortScanner.scan).mockResolvedValue(ok([{ port: 8080, pid: 3000 }]));
    vi.mocked(mockInstanceProbe.probe).mockResolvedValue(ok("/workspace/b"));

    await service.scan();
    expect(mockInstanceProbe.probe).toHaveBeenCalledTimes(2);
  });

  it("prevents concurrent scans", async () => {
    service.setCodeServerPid(1000);
    vi.mocked(mockProcessTree.getDescendantPids).mockImplementation(async () => {
      // Slow operation
      await new Promise((resolve) => setTimeout(resolve, 100));
      return new Set([2000]);
    });
    vi.mocked(mockPortScanner.scan).mockResolvedValue(ok([]));

    // Start two concurrent scans
    const scan1 = service.scan();
    const scan2 = service.scan();

    // Second scan should return immediately with SCAN_IN_PROGRESS
    const result2 = await scan2;
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.error.code).toBe("SCAN_IN_PROGRESS");
    }

    // Advance timers to let first scan complete
    await vi.advanceTimersByTimeAsync(200);
    const result1 = await scan1;
    expect(result1.ok).toBe(true);
  });

  it("handles port scanner errors", async () => {
    service.setCodeServerPid(1000);
    vi.mocked(mockProcessTree.getDescendantPids).mockResolvedValue(new Set([2000]));
    vi.mocked(mockPortScanner.scan).mockResolvedValue(
      err({ code: "NETSTAT_FAILED", message: "Command failed" })
    );

    const result = await service.scan();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PORT_SCAN_FAILED");
    }
  });

  it("notifies listener when workspace ports change", async () => {
    const listener = vi.fn();
    service.onInstancesChanged(listener);

    service.setCodeServerPid(1000);
    vi.mocked(mockProcessTree.getDescendantPids).mockResolvedValue(new Set([2000]));
    vi.mocked(mockPortScanner.scan).mockResolvedValue(ok([{ port: 8080, pid: 2000 }]));
    vi.mocked(mockInstanceProbe.probe).mockResolvedValue(ok("/workspace/a"));

    await service.scan();

    expect(listener).toHaveBeenCalledWith("/workspace/a", new Set([8080]));
  });

  it("notifies listener when port disappears", async () => {
    const listener = vi.fn();
    service.onInstancesChanged(listener);

    service.setCodeServerPid(1000);
    vi.mocked(mockProcessTree.getDescendantPids).mockResolvedValue(new Set([2000]));
    vi.mocked(mockPortScanner.scan).mockResolvedValue(ok([{ port: 8080, pid: 2000 }]));
    vi.mocked(mockInstanceProbe.probe).mockResolvedValue(ok("/workspace/a"));

    // First scan - add port
    await service.scan();
    listener.mockClear();

    // Second scan - port gone
    vi.mocked(mockPortScanner.scan).mockResolvedValue(ok([]));

    await service.scan();

    expect(listener).toHaveBeenCalledWith("/workspace/a", new Set());
  });

  it("cleans up stale cache entries on TTL expiry", async () => {
    service.setCodeServerPid(1000);
    vi.mocked(mockProcessTree.getDescendantPids).mockResolvedValue(new Set([2000]));
    vi.mocked(mockPortScanner.scan).mockResolvedValue(ok([{ port: 8080, pid: 2000 }]));
    vi.mocked(mockInstanceProbe.probe).mockResolvedValue(
      err({ code: "NOT_OPENCODE", message: "Not an OpenCode instance" })
    );

    // First scan - caches the non-OpenCode port
    await service.scan();
    expect(mockInstanceProbe.probe).toHaveBeenCalledTimes(1);

    // Advance time past TTL (5 minutes)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    // This scan should trigger cleanup and re-probe
    await service.scan();
    expect(mockInstanceProbe.probe).toHaveBeenCalledTimes(2);
  });
});
