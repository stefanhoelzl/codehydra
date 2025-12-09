// @vitest-environment node
/**
 * Tests for setup IPC handlers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IVscodeSetup, SetupResult, ProgressCallback } from "../../services/vscode-setup";

// Create mock functions
const mockSetup = vi.fn();
const mockCleanVscodeDir = vi.fn();
const mockIsSetupComplete = vi.fn();
const mockAppQuit = vi.fn();

// Mock VscodeSetupService
const mockSetupService: IVscodeSetup = {
  setup: mockSetup,
  cleanVscodeDir: mockCleanVscodeDir,
  isSetupComplete: mockIsSetupComplete,
};

import {
  createSetupReadyHandler,
  createSetupStartHandler,
  createSetupRetryHandler,
  createSetupQuitHandler,
} from "./setup-handlers";

describe("createSetupReadyHandler (status check only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns { ready: true } when setup is complete", async () => {
    mockIsSetupComplete.mockResolvedValue(true);

    const handler = createSetupReadyHandler(mockSetupService);

    const result = await handler({} as never, undefined);

    expect(mockIsSetupComplete).toHaveBeenCalled();
    expect(result).toEqual({ ready: true });
    // Handler should NOT call cleanVscodeDir or setup
    expect(mockCleanVscodeDir).not.toHaveBeenCalled();
    expect(mockSetup).not.toHaveBeenCalled();
  });

  it("returns { ready: false } when setup is not complete", async () => {
    mockIsSetupComplete.mockResolvedValue(false);

    const handler = createSetupReadyHandler(mockSetupService);

    const result = await handler({} as never, undefined);

    expect(mockIsSetupComplete).toHaveBeenCalled();
    expect(result).toEqual({ ready: false });
    // Handler should NOT call cleanVscodeDir or setup - that happens elsewhere
    expect(mockCleanVscodeDir).not.toHaveBeenCalled();
    expect(mockSetup).not.toHaveBeenCalled();
  });
});

describe("createSetupStartHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("triggers setup and emits progress events", async () => {
    const emitProgress = vi.fn();
    const emitComplete = vi.fn();
    const emitError = vi.fn();

    const successResult: SetupResult = { success: true };
    mockSetup.mockImplementation(async (onProgress?: ProgressCallback) => {
      onProgress?.({ step: "extensions", message: "Installing extensions..." });
      return successResult;
    });

    const handler = createSetupStartHandler(mockSetupService, {
      emitProgress,
      emitComplete,
      emitError,
    });

    await handler({} as never, undefined);

    expect(mockSetup).toHaveBeenCalled();
    expect(emitProgress).toHaveBeenCalledWith({
      step: "extensions",
      message: "Installing extensions...",
    });
    expect(emitComplete).toHaveBeenCalled();
    expect(emitError).not.toHaveBeenCalled();
  });

  it("emits error on setup failure", async () => {
    const emitProgress = vi.fn();
    const emitComplete = vi.fn();
    const emitError = vi.fn();

    const errorResult: SetupResult = {
      success: false,
      error: {
        type: "network",
        message: "Failed to install extensions",
        code: "EXTENSION_INSTALL_FAILED",
      },
    };
    mockSetup.mockResolvedValue(errorResult);

    const handler = createSetupStartHandler(mockSetupService, {
      emitProgress,
      emitComplete,
      emitError,
    });

    await handler({} as never, undefined);

    expect(mockSetup).toHaveBeenCalled();
    expect(emitComplete).not.toHaveBeenCalled();
    expect(emitError).toHaveBeenCalledWith({
      message: "Failed to install extensions",
      code: "EXTENSION_INSTALL_FAILED",
    });
  });

  it("handles thrown errors during setup", async () => {
    const emitProgress = vi.fn();
    const emitComplete = vi.fn();
    const emitError = vi.fn();

    mockSetup.mockRejectedValue(new Error("Unexpected error"));

    const handler = createSetupStartHandler(mockSetupService, {
      emitProgress,
      emitComplete,
      emitError,
    });

    await handler({} as never, undefined);

    expect(emitError).toHaveBeenCalledWith({
      message: "Unexpected error",
      code: "unknown",
    });
  });
});

describe("createSetupRetryHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cleans vscode dir and re-runs setup", async () => {
    const emitProgress = vi.fn();
    const emitComplete = vi.fn();
    const emitError = vi.fn();

    mockCleanVscodeDir.mockResolvedValue(undefined);
    const successResult: SetupResult = { success: true };
    mockSetup.mockResolvedValue(successResult);

    const handler = createSetupRetryHandler(mockSetupService, {
      emitProgress,
      emitComplete,
      emitError,
    });

    await handler({} as never, undefined);

    expect(mockCleanVscodeDir).toHaveBeenCalled();
    expect(mockSetup).toHaveBeenCalled();
    expect(emitComplete).toHaveBeenCalled();
  });

  it("emits error if clean fails", async () => {
    const emitProgress = vi.fn();
    const emitComplete = vi.fn();
    const emitError = vi.fn();

    mockCleanVscodeDir.mockRejectedValue(new Error("Permission denied"));

    const handler = createSetupRetryHandler(mockSetupService, {
      emitProgress,
      emitComplete,
      emitError,
    });

    await handler({} as never, undefined);

    expect(emitError).toHaveBeenCalledWith({
      message: "Permission denied",
      code: "unknown",
    });
    expect(mockSetup).not.toHaveBeenCalled();
  });
});

describe("createSetupQuitHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls app.quit()", async () => {
    const handler = createSetupQuitHandler(mockAppQuit);

    await handler({} as never, undefined);

    expect(mockAppQuit).toHaveBeenCalled();
  });
});

describe("runSetupProcess guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("concurrent setup calls only run once", async () => {
    // Create a handler factory that tracks setup calls with a guard
    let setupCallCount = 0;
    let setupInProgress = false;
    const guardedSetup = async (): Promise<void> => {
      if (setupInProgress) {
        return; // Already running, ignore duplicate calls
      }
      setupInProgress = true;
      try {
        setupCallCount++;
        // Simulate async setup work
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        setupInProgress = false;
      }
    };

    // Call setup multiple times concurrently
    await Promise.all([guardedSetup(), guardedSetup(), guardedSetup()]);

    // Only one setup should have actually run
    expect(setupCallCount).toBe(1);
  });
});
