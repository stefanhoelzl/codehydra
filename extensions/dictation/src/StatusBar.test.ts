import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StatusBar } from "./StatusBar";

// Track mock function calls
const mockStatusBarItem = {
  text: "",
  tooltip: "",
  command: undefined as string | undefined,
  color: undefined as unknown,
  backgroundColor: undefined as unknown,
  show: vi.fn(),
  dispose: vi.fn(),
};

// Mock vscode
vi.mock("vscode", () => {
  // ThemeColor needs to be a real class for `new vscode.ThemeColor()` to work
  class ThemeColor {
    id: string;
    constructor(color: string) {
      this.id = color;
    }
  }

  return {
    window: {
      createStatusBarItem: vi.fn(() => mockStatusBarItem),
    },
    StatusBarAlignment: {
      Right: 2,
    },
    ThemeColor,
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: vi.fn((key: string) => {
          if (key === "assemblyai.apiKey") return "test-api-key";
          return undefined;
        }),
      })),
    },
  };
});

describe("StatusBar", () => {
  let statusBar: StatusBar;

  beforeEach(() => {
    vi.useFakeTimers();
    // Reset mock state
    mockStatusBarItem.text = "";
    mockStatusBarItem.tooltip = "";
    mockStatusBarItem.command = undefined;
    mockStatusBarItem.color = undefined;
    mockStatusBarItem.backgroundColor = undefined;
    mockStatusBarItem.show.mockClear();
    mockStatusBarItem.dispose.mockClear();

    statusBar = new StatusBar();
  });

  afterEach(() => {
    statusBar.dispose();
    vi.useRealTimers();
  });

  describe("error state auto-clear", () => {
    it("auto-clears error state to idle after 3 seconds", async () => {
      // Set error state
      statusBar.update("error", { errorMessage: "Test error" });

      // Verify error state
      expect(mockStatusBarItem.text).toBe("$(error)");
      expect(mockStatusBarItem.tooltip).toBe("Dictation failed: Test error");

      // Wait less than 3 seconds - still error
      await vi.advanceTimersByTimeAsync(2999);
      expect(mockStatusBarItem.text).toBe("$(error)");

      // Wait past 3 seconds - should be idle
      await vi.advanceTimersByTimeAsync(2);
      expect(mockStatusBarItem.text).toBe("$(record)");
      expect(mockStatusBarItem.tooltip).toBe("Start dictation (F10)");
    });

    it("cancels auto-clear timer when state changes away from error", async () => {
      // Set error state
      statusBar.update("error", { errorMessage: "Test error" });
      expect(mockStatusBarItem.text).toBe("$(error)");

      // Wait 1 second
      await vi.advanceTimersByTimeAsync(1000);

      // Change to idle manually
      statusBar.update("idle");
      expect(mockStatusBarItem.text).toBe("$(record)");

      // Wait past the original 3 second timer - should still be idle (timer was cancelled)
      await vi.advanceTimersByTimeAsync(3000);
      expect(mockStatusBarItem.text).toBe("$(record)");
    });

    it("resets auto-clear timer on new error", async () => {
      // Set error state
      statusBar.update("error", { errorMessage: "First error" });

      // Wait 2 seconds
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockStatusBarItem.text).toBe("$(error)");

      // Set new error - resets timer
      statusBar.update("error", { errorMessage: "Second error" });
      expect(mockStatusBarItem.tooltip).toBe("Dictation failed: Second error");

      // Wait 2 more seconds (4 total from first error, but only 2 from second)
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockStatusBarItem.text).toBe("$(error)");

      // Wait 1 more second (3 total from second error) - should clear
      await vi.advanceTimersByTimeAsync(1001);
      expect(mockStatusBarItem.text).toBe("$(record)");
    });
  });

  describe("state display", () => {
    it("shows correct appearance for idle state", () => {
      statusBar.update("idle");

      expect(mockStatusBarItem.text).toBe("$(record)");
      expect(mockStatusBarItem.tooltip).toBe("Start dictation (F10)");
      expect(mockStatusBarItem.color).toBeUndefined();
    });

    it("shows correct appearance for loading state", () => {
      statusBar.update("loading");

      expect(mockStatusBarItem.text).toBe("$(loading~spin)");
      expect(mockStatusBarItem.tooltip).toBe("Initializing dictation...");
    });

    it("shows correct appearance for listening state (orange)", () => {
      statusBar.update("listening", { startTime: Date.now() });

      expect(mockStatusBarItem.text).toBe("$(mic)");
      expect(mockStatusBarItem.color).toEqual({ id: "editorWarning.foreground" });
    });

    it("shows correct appearance for active state (green)", () => {
      statusBar.update("active", { startTime: Date.now() });

      expect(mockStatusBarItem.text).toBe("$(mic-filled)");
      expect(mockStatusBarItem.color).toEqual({ id: "testing.iconPassed" });
    });

    it("shows correct appearance for stopping state", () => {
      statusBar.update("stopping");

      expect(mockStatusBarItem.text).toBe("$(loading~spin)");
      expect(mockStatusBarItem.tooltip).toBe("Stopping dictation...");
    });

    it("shows correct appearance for error state (red)", () => {
      statusBar.update("error", { errorMessage: "Test error" });

      expect(mockStatusBarItem.text).toBe("$(error)");
      expect(mockStatusBarItem.tooltip).toBe("Dictation failed: Test error");
      expect(mockStatusBarItem.color).toEqual({ id: "errorForeground" });
    });
  });
});
