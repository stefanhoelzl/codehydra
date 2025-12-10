/**
 * Tests for ElectronBuildInfo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Track mock isPackaged value
let mockIsPackaged = false;

// Mock Electron app module with getter
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mockIsPackaged;
    },
  },
}));

import { ElectronBuildInfo } from "./build-info";

describe("ElectronBuildInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPackaged = false;
  });

  afterEach(() => {
    mockIsPackaged = false;
  });

  it("returns isDevelopment: true when app is not packaged", () => {
    mockIsPackaged = false;

    const buildInfo = new ElectronBuildInfo();

    expect(buildInfo.isDevelopment).toBe(true);
  });

  it("returns isDevelopment: false when app is packaged", () => {
    mockIsPackaged = true;

    const buildInfo = new ElectronBuildInfo();

    expect(buildInfo.isDevelopment).toBe(false);
  });

  it("caches the isDevelopment value at construction time", () => {
    mockIsPackaged = false;
    const buildInfo = new ElectronBuildInfo();

    // Change the mock value after construction
    mockIsPackaged = true;

    // Should still return the original cached value
    expect(buildInfo.isDevelopment).toBe(true);
  });
});
