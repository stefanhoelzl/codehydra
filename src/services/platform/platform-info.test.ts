/**
 * Tests for PlatformInfo interface and mock factory.
 */

import { describe, it, expect } from "vitest";
import { createMockPlatformInfo } from "./platform-info.test-utils";
import type { PlatformInfo } from "./platform-info";

describe("createMockPlatformInfo", () => {
  it("returns sensible defaults", () => {
    const platformInfo = createMockPlatformInfo();

    expect(platformInfo.platform).toBe("linux");
    expect(platformInfo.homeDir).toBe("/home/test");
  });

  it("accepts override for platform", () => {
    const platformInfo = createMockPlatformInfo({ platform: "darwin" });

    expect(platformInfo.platform).toBe("darwin");
    expect(platformInfo.homeDir).toBe("/home/test"); // default still applies
  });

  it("accepts override for homeDir", () => {
    const platformInfo = createMockPlatformInfo({ homeDir: "/Users/testuser" });

    expect(platformInfo.homeDir).toBe("/Users/testuser");
    expect(platformInfo.platform).toBe("linux"); // default still applies
  });

  it("accepts both overrides together", () => {
    const platformInfo = createMockPlatformInfo({
      platform: "win32",
      homeDir: "C:\\Users\\TestUser",
    });

    expect(platformInfo.platform).toBe("win32");
    expect(platformInfo.homeDir).toBe("C:\\Users\\TestUser");
  });

  it("returns object satisfying PlatformInfo interface", () => {
    const platformInfo: PlatformInfo = createMockPlatformInfo();

    // TypeScript ensures type compatibility at compile time
    // This test verifies the interface is implemented correctly
    expect(platformInfo).toHaveProperty("platform");
    expect(platformInfo).toHaveProperty("homeDir");
    expect(typeof platformInfo.platform).toBe("string");
    expect(typeof platformInfo.homeDir).toBe("string");
  });
});
