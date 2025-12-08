// @vitest-environment node
/**
 * Tests for ProcessTreeProvider interface and PidtreeProvider implementation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PidtreeProvider, type ProcessTreeProvider } from "./process-tree";

// Mock pidtree
vi.mock("pidtree", () => ({
  default: vi.fn(),
}));

import pidtree from "pidtree";

// Type assertion to simplify mock type - pidtree returns number[] by default
const mockPidtree = pidtree as unknown as {
  mockResolvedValue: (value: number[]) => void;
  mockRejectedValue: (error: Error) => void;
} & ((pid: number) => Promise<number[]>);

describe("PidtreeProvider", () => {
  let provider: ProcessTreeProvider;

  beforeEach(() => {
    provider = new PidtreeProvider();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("getDescendantPids", () => {
    it("returns descendant PIDs as a Set", async () => {
      mockPidtree.mockResolvedValue([1001, 1002, 1003]);

      const result = await provider.getDescendantPids(1000);

      expect(result).toBeInstanceOf(Set);
      expect(result.has(1001)).toBe(true);
      expect(result.has(1002)).toBe(true);
      expect(result.has(1003)).toBe(true);
    });

    it("returns empty Set when no descendants", async () => {
      mockPidtree.mockResolvedValue([]);

      const result = await provider.getDescendantPids(1000);

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });

    it("returns empty Set on error (graceful degradation)", async () => {
      mockPidtree.mockRejectedValue(new Error("Process not found"));

      const result = await provider.getDescendantPids(1000);

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });

    it("passes the correct PID to pidtree", async () => {
      mockPidtree.mockResolvedValue([]);

      await provider.getDescendantPids(9999);

      expect(pidtree).toHaveBeenCalledWith(9999);
    });
  });
});
