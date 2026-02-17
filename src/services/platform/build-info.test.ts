/**
 * Tests for BuildInfo interface and mock factory.
 */

import { describe, it, expect } from "vitest";
import { createMockBuildInfo } from "./build-info.test-utils";
import type { BuildInfo } from "./build-info";

describe("createMockBuildInfo", () => {
  it("returns version: '1.0.0-test' by default", () => {
    const buildInfo = createMockBuildInfo();

    expect(buildInfo.version).toBe("1.0.0-test");
  });

  it("returns isDevelopment: true by default", () => {
    const buildInfo = createMockBuildInfo();

    expect(buildInfo.isDevelopment).toBe(true);
  });

  it("returns isPackaged: false by default", () => {
    const buildInfo = createMockBuildInfo();

    expect(buildInfo.isPackaged).toBe(false);
  });

  it("returns gitBranch: 'test-branch' by default when not packaged", () => {
    const buildInfo = createMockBuildInfo();

    expect(buildInfo.gitBranch).toBe("test-branch");
  });

  it("accepts override for version", () => {
    const buildInfo = createMockBuildInfo({ version: "2.0.0" });

    expect(buildInfo.version).toBe("2.0.0");
  });

  it("accepts override for isDevelopment", () => {
    const buildInfo = createMockBuildInfo({ isDevelopment: false });

    expect(buildInfo.isDevelopment).toBe(false);
  });

  it("accepts override for isPackaged", () => {
    const buildInfo = createMockBuildInfo({ isPackaged: true });

    expect(buildInfo.isPackaged).toBe(true);
  });

  it("returns undefined gitBranch when isPackaged is true", () => {
    const buildInfo = createMockBuildInfo({ isPackaged: true });

    expect(buildInfo.gitBranch).toBeUndefined();
  });

  it("accepts override for gitBranch", () => {
    const buildInfo = createMockBuildInfo({ gitBranch: "feature/my-branch" });

    expect(buildInfo.gitBranch).toBe("feature/my-branch");
  });

  it("returns object satisfying BuildInfo interface", () => {
    const buildInfo: BuildInfo = createMockBuildInfo();

    // TypeScript ensures type compatibility at compile time
    // This test verifies the interface is implemented correctly
    expect(buildInfo).toHaveProperty("version");
    expect(buildInfo).toHaveProperty("isDevelopment");
    expect(buildInfo).toHaveProperty("isPackaged");
    expect(typeof buildInfo.version).toBe("string");
    expect(typeof buildInfo.isDevelopment).toBe("boolean");
    expect(typeof buildInfo.isPackaged).toBe("boolean");
  });
});
