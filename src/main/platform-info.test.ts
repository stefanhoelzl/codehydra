/**
 * Tests for NodePlatformInfo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import { NodePlatformInfo } from "./platform-info";

// Store original values
const originalPlatform = process.platform;

describe("NodePlatformInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(os, "homedir");
  });

  afterEach(() => {
    // Restore platform
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
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

  it("caches values at construction time", () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      writable: true,
    });
    vi.mocked(os.homedir).mockReturnValue("/home/original");

    const platformInfo = new NodePlatformInfo();

    // Change values after construction
    Object.defineProperty(process, "platform", {
      value: "win32",
      writable: true,
    });
    vi.mocked(os.homedir).mockReturnValue("/home/changed");

    // Should still return original cached values
    expect(platformInfo.platform).toBe("linux");
    expect(platformInfo.homeDir).toBe("/home/original");
  });
});
