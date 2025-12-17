/**
 * Tests for LifecycleApi class.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { LifecycleApi } from "./lifecycle-api";
import type { IVscodeSetup, SetupResult } from "../../services/vscode-setup/types";

// =============================================================================
// Test Utilities
// =============================================================================

function createMockVscodeSetup(
  overrides: {
    isSetupComplete?: boolean;
    setupResult?: SetupResult;
  } = {}
): IVscodeSetup {
  const { isSetupComplete = true, setupResult = { success: true } } = overrides;

  return {
    isSetupComplete: vi.fn().mockResolvedValue(isSetupComplete),
    setup: vi.fn().mockResolvedValue(setupResult),
    cleanVscodeDir: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockApp(): { quit: ReturnType<typeof vi.fn> } {
  return {
    quit: vi.fn(),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("LifecycleApi", () => {
  let mockSetup: IVscodeSetup;
  let mockApp: ReturnType<typeof createMockApp>;
  let onSetupComplete: ReturnType<typeof vi.fn>;
  let emitProgress: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSetup = createMockVscodeSetup();
    mockApp = createMockApp();
    onSetupComplete = vi.fn().mockResolvedValue(undefined);
    emitProgress = vi.fn();
  });

  describe("getState()", () => {
    it("returns 'ready' when setup is complete", async () => {
      mockSetup = createMockVscodeSetup({ isSetupComplete: true });
      const api = new LifecycleApi(mockSetup, mockApp, onSetupComplete, emitProgress);

      const state = await api.getState();

      expect(state).toBe("ready");
    });

    it("returns 'setup' when setup is incomplete", async () => {
      mockSetup = createMockVscodeSetup({ isSetupComplete: false });
      const api = new LifecycleApi(mockSetup, mockApp, onSetupComplete, emitProgress);

      const state = await api.getState();

      expect(state).toBe("setup");
    });
  });

  describe("setup()", () => {
    it("calls cleanVscodeDir before running setup (auto-clean)", async () => {
      mockSetup = createMockVscodeSetup({ isSetupComplete: false });
      const api = new LifecycleApi(mockSetup, mockApp, onSetupComplete, emitProgress);

      await api.setup();

      expect(mockSetup.cleanVscodeDir).toHaveBeenCalled();
      expect(mockSetup.setup).toHaveBeenCalled();

      // Verify clean is called before setup
      const cleanOrder = (mockSetup.cleanVscodeDir as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      const setupOrder = (mockSetup.setup as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(cleanOrder).toBeLessThan(setupOrder!);
    });

    it("emits progress events during setup", async () => {
      const mockSetupService = createMockVscodeSetup({ isSetupComplete: false });
      // Capture the progress callback and invoke it
      (mockSetupService.setup as ReturnType<typeof vi.fn>).mockImplementation(
        async (onProgress: (progress: { step: string; message: string }) => void) => {
          onProgress({ step: "binary-download", message: "Setting up code-server..." });
          onProgress({ step: "extensions", message: "Installing extensions..." });
          onProgress({ step: "config", message: "Configuring settings..." });
          return { success: true };
        }
      );

      const api = new LifecycleApi(mockSetupService, mockApp, onSetupComplete, emitProgress);
      await api.setup();

      expect(emitProgress).toHaveBeenCalledTimes(3);
      expect(emitProgress).toHaveBeenCalledWith({
        step: "binary-download",
        message: "Setting up code-server...",
      });
      expect(emitProgress).toHaveBeenCalledWith({
        step: "extensions",
        message: "Installing extensions...",
      });
      expect(emitProgress).toHaveBeenCalledWith({
        step: "settings",
        message: "Configuring settings...",
      });
    });

    it("calls onSetupComplete callback on success", async () => {
      mockSetup = createMockVscodeSetup({ isSetupComplete: false });
      const api = new LifecycleApi(mockSetup, mockApp, onSetupComplete, emitProgress);

      const result = await api.setup();

      expect(result).toEqual({ success: true });
      expect(onSetupComplete).toHaveBeenCalledTimes(1);
    });

    it("returns failure result on error", async () => {
      mockSetup = createMockVscodeSetup({
        isSetupComplete: false,
        setupResult: { success: false, error: { type: "network", message: "Failed to install" } },
      });
      const api = new LifecycleApi(mockSetup, mockApp, onSetupComplete, emitProgress);

      const result = await api.setup();

      expect(result).toEqual({
        success: false,
        message: "Failed to install",
        code: "network",
      });
      // onSetupComplete should NOT be called on failure
      expect(onSetupComplete).not.toHaveBeenCalled();
    });

    it("guards against concurrent setup calls", async () => {
      mockSetup = createMockVscodeSetup({ isSetupComplete: false });
      // Make setup take time
      let resolveSetup: () => void;
      (mockSetup.setup as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise<SetupResult>((resolve) => {
          resolveSetup = () => resolve({ success: true });
        })
      );

      const api = new LifecycleApi(mockSetup, mockApp, onSetupComplete, emitProgress);

      // Start first setup
      const promise1 = api.setup();

      // Try to start second setup immediately
      const promise2 = api.setup();

      // Second call should return immediately with SETUP_IN_PROGRESS
      const result2 = await promise2;
      expect(result2).toEqual({
        success: false,
        message: "Setup already in progress",
        code: "SETUP_IN_PROGRESS",
      });

      // Complete first setup
      resolveSetup!();
      const result1 = await promise1;
      expect(result1).toEqual({ success: true });
    });

    it("returns success immediately if already complete", async () => {
      mockSetup = createMockVscodeSetup({ isSetupComplete: true });
      const api = new LifecycleApi(mockSetup, mockApp, onSetupComplete, emitProgress);

      const result = await api.setup();

      expect(result).toEqual({ success: true });
      // Should not run cleanVscodeDir or setup
      expect(mockSetup.cleanVscodeDir).not.toHaveBeenCalled();
      expect(mockSetup.setup).not.toHaveBeenCalled();
      // Should still call onSetupComplete (services need to be started)
      expect(onSetupComplete).toHaveBeenCalledTimes(1);
    });

    it("handles error in onSetupComplete callback", async () => {
      mockSetup = createMockVscodeSetup({ isSetupComplete: false });
      onSetupComplete.mockRejectedValue(new Error("Services failed to start"));

      const api = new LifecycleApi(mockSetup, mockApp, onSetupComplete, emitProgress);
      const result = await api.setup();

      // Should propagate the error as a failure result
      expect(result).toEqual({
        success: false,
        message: "Services failed to start",
        code: "SERVICE_START_ERROR",
      });
    });

    it("resets setupInProgress flag on error", async () => {
      mockSetup = createMockVscodeSetup({ isSetupComplete: false });
      (mockSetup.setup as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Setup failed"));

      const api = new LifecycleApi(mockSetup, mockApp, onSetupComplete, emitProgress);

      // First call fails
      await api.setup();

      // Second call should work (flag reset)
      (mockSetup.setup as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
      const result = await api.setup();

      expect(result).toEqual({ success: true });
    });

    it("filters out finalize step from progress events", async () => {
      const mockSetupService = createMockVscodeSetup({ isSetupComplete: false });
      (mockSetupService.setup as ReturnType<typeof vi.fn>).mockImplementation(
        async (onProgress: (progress: { step: string; message: string }) => void) => {
          onProgress({ step: "extensions", message: "Installing..." });
          onProgress({ step: "finalize", message: "Finalizing..." });
          return { success: true };
        }
      );

      const api = new LifecycleApi(mockSetupService, mockApp, onSetupComplete, emitProgress);
      await api.setup();

      // Should only emit extensions, not finalize
      expect(emitProgress).toHaveBeenCalledTimes(1);
      expect(emitProgress).toHaveBeenCalledWith({
        step: "extensions",
        message: "Installing...",
      });
    });
  });

  describe("quit()", () => {
    it("calls app.quit()", async () => {
      const api = new LifecycleApi(mockSetup, mockApp, onSetupComplete, emitProgress);

      await api.quit();

      expect(mockApp.quit).toHaveBeenCalledTimes(1);
    });
  });
});
