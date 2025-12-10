/**
 * Tests for BuildInfo interface and mock factory.
 */

import { describe, it, expect } from "vitest";
import { createMockBuildInfo } from "./build-info.test-utils";
import type { BuildInfo } from "./build-info";

describe("createMockBuildInfo", () => {
  it("returns isDevelopment: true by default", () => {
    const buildInfo = createMockBuildInfo();

    expect(buildInfo.isDevelopment).toBe(true);
  });

  it("accepts override for isDevelopment", () => {
    const buildInfo = createMockBuildInfo({ isDevelopment: false });

    expect(buildInfo.isDevelopment).toBe(false);
  });

  it("returns object satisfying BuildInfo interface", () => {
    const buildInfo: BuildInfo = createMockBuildInfo();

    // TypeScript ensures type compatibility at compile time
    // This test verifies the interface is implemented correctly
    expect(buildInfo).toHaveProperty("isDevelopment");
    expect(typeof buildInfo.isDevelopment).toBe("boolean");
  });
});
