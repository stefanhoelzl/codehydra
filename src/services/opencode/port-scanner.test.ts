// @vitest-environment node
/**
 * Tests for PortScanner interface and SiPortScanner implementation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SiPortScanner, type PortScanner } from "./port-scanner";

// Mock systeminformation
vi.mock("systeminformation", () => ({
  default: {
    networkConnections: vi.fn(),
  },
}));

import si from "systeminformation";

const mockNetworkConnections = vi.mocked(si.networkConnections);

describe("SiPortScanner", () => {
  let scanner: PortScanner;

  beforeEach(() => {
    scanner = new SiPortScanner();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("scan", () => {
    it("returns listening ports with PIDs", async () => {
      mockNetworkConnections.mockResolvedValue([
        {
          protocol: "tcp",
          localAddress: "127.0.0.1",
          localPort: "8080",
          peerAddress: "0.0.0.0",
          peerPort: "0",
          state: "LISTEN",
          pid: 1234,
          process: "node",
        },
        {
          protocol: "tcp",
          localAddress: "0.0.0.0",
          localPort: "3000",
          peerAddress: "0.0.0.0",
          peerPort: "0",
          state: "LISTEN",
          pid: 5678,
          process: "node",
        },
      ]);

      const result = await scanner.scan();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value).toContainEqual({ port: 8080, pid: 1234 });
        expect(result.value).toContainEqual({ port: 3000, pid: 5678 });
      }
    });

    it("filters out entries without PID (pid = 0)", async () => {
      mockNetworkConnections.mockResolvedValue([
        {
          protocol: "tcp",
          localAddress: "127.0.0.1",
          localPort: "8080",
          peerAddress: "0.0.0.0",
          peerPort: "0",
          state: "LISTEN",
          pid: 1234,
          process: "node",
        },
        {
          protocol: "tcp",
          localAddress: "127.0.0.1",
          localPort: "9090",
          peerAddress: "0.0.0.0",
          peerPort: "0",
          state: "LISTEN",
          pid: 0, // No PID
          process: "",
        },
      ]);

      const result = await scanner.scan();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0]).toEqual({ port: 8080, pid: 1234 });
      }
    });

    it("includes both LISTEN and ESTABLISHED connections", async () => {
      mockNetworkConnections.mockResolvedValue([
        {
          protocol: "tcp",
          localAddress: "127.0.0.1",
          localPort: "8080",
          peerAddress: "0.0.0.0",
          peerPort: "0",
          state: "LISTEN",
          pid: 1234,
          process: "node",
        },
        {
          protocol: "tcp",
          localAddress: "127.0.0.1",
          localPort: "9090",
          peerAddress: "192.168.1.1",
          peerPort: "443",
          state: "ESTABLISHED",
          pid: 5678,
          process: "node",
        },
      ]);

      const result = await scanner.scan();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value).toContainEqual({ port: 8080, pid: 1234 });
        expect(result.value).toContainEqual({ port: 9090, pid: 5678 });
      }
    });

    it("filters out other connection states like TIME_WAIT", async () => {
      mockNetworkConnections.mockResolvedValue([
        {
          protocol: "tcp",
          localAddress: "127.0.0.1",
          localPort: "8080",
          peerAddress: "0.0.0.0",
          peerPort: "0",
          state: "LISTEN",
          pid: 1234,
          process: "node",
        },
        {
          protocol: "tcp",
          localAddress: "127.0.0.1",
          localPort: "9090",
          peerAddress: "192.168.1.1",
          peerPort: "443",
          state: "TIME_WAIT",
          pid: 5678,
          process: "node",
        },
        {
          protocol: "tcp",
          localAddress: "127.0.0.1",
          localPort: "7070",
          peerAddress: "192.168.1.1",
          peerPort: "80",
          state: "CLOSE_WAIT",
          pid: 9999,
          process: "node",
        },
      ]);

      const result = await scanner.scan();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0]).toEqual({ port: 8080, pid: 1234 });
      }
    });

    it("returns empty array when no ports found", async () => {
      mockNetworkConnections.mockResolvedValue([]);

      const result = await scanner.scan();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(0);
      }
    });

    it("returns error on systeminformation failure", async () => {
      mockNetworkConnections.mockRejectedValue(new Error("Permission denied"));

      const result = await scanner.scan();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NETSTAT_FAILED");
        expect(result.error.message).toContain("Permission denied");
      }
    });

    it("handles non-Error exceptions", async () => {
      mockNetworkConnections.mockRejectedValue("Unknown failure");

      const result = await scanner.scan();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NETSTAT_FAILED");
        expect(result.error.message).toBe("Unknown error");
      }
    });
  });
});
