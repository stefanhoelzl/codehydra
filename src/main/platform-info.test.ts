/**
 * Tests for NodePlatformInfo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import { NodePlatformInfo } from "./platform-info";

// Store original values
const originalPlatform = process.platform;
const originalArch = process.arch;

describe("NodePlatformInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(os, "homedir");
  });

  afterEach(() => {
    // Restore platform and arch
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
    });
    Object.defineProperty(process, "arch", {
      value: originalArch,
      writable: true,
    });
  });

  it("returns platform from process.platform", () => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      writable: true,
    });

    const platformInfo = new NodePlatformInfo();

    expect(platformInfo.platform).toBe("darwin");
  });

  it("returns homeDir from os.homedir()", () => {
    vi.mocked(os.homedir).mockReturnValue("/Users/testuser");

    const platformInfo = new NodePlatformInfo();

    expect(platformInfo.homeDir).toBe("/Users/testuser");
  });

  describe("arch", () => {
    it("returns x64 for x64 architecture", () => {
      Object.defineProperty(process, "arch", {
        value: "x64",
        writable: true,
      });

      const platformInfo = new NodePlatformInfo();

      expect(platformInfo.arch).toBe("x64");
    });

    it("returns arm64 for arm64 architecture", () => {
      Object.defineProperty(process, "arch", {
        value: "arm64",
        writable: true,
      });

      const platformInfo = new NodePlatformInfo();

      expect(platformInfo.arch).toBe("arm64");
    });

    it("throws for unsupported ia32 architecture", () => {
      Object.defineProperty(process, "arch", {
        value: "ia32",
        writable: true,
      });

      expect(() => new NodePlatformInfo()).toThrow(
        "Unsupported architecture: ia32. CodeHydra requires x64 or arm64."
      );
    });

    it("throws for unsupported arm architecture", () => {
      Object.defineProperty(process, "arch", {
        value: "arm",
        writable: true,
      });

      expect(() => new NodePlatformInfo()).toThrow(
        "Unsupported architecture: arm. CodeHydra requires x64 or arm64."
      );
    });

    it("throws for unsupported ppc64 architecture", () => {
      Object.defineProperty(process, "arch", {
        value: "ppc64",
        writable: true,
      });

      expect(() => new NodePlatformInfo()).toThrow(
        "Unsupported architecture: ppc64. CodeHydra requires x64 or arm64."
      );
    });
  });

  it("caches values at construction time", () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      writable: true,
    });
    Object.defineProperty(process, "arch", {
      value: "x64",
      writable: true,
    });
    vi.mocked(os.homedir).mockReturnValue("/home/original");

    const platformInfo = new NodePlatformInfo();

    // Change values after construction
    Object.defineProperty(process, "platform", {
      value: "win32",
      writable: true,
    });
    Object.defineProperty(process, "arch", {
      value: "arm64",
      writable: true,
    });
    vi.mocked(os.homedir).mockReturnValue("/home/changed");

    // Should still return original cached values
    expect(platformInfo.platform).toBe("linux");
    expect(platformInfo.arch).toBe("x64");
    expect(platformInfo.homeDir).toBe("/home/original");
  });
});
