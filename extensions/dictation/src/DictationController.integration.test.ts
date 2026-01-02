import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Uri } from "vscode";
import { MockProvider } from "./providers/mock";
import type { DictationError } from "./providers/types";
import type {
  AudioCapturePanel,
  AudioHandler,
  CaptureErrorHandler,
} from "./audio/AudioCapturePanel";
import { DictationController, type DictationState } from "./DictationController";

// Track mock function calls - must use vi.fn() inline in the factory
// because vi.mock is hoisted to the top of the file
vi.mock("vscode", () => {
  const showErrorMessage = vi.fn();
  const showInformationMessage = vi.fn();
  const executeCommand = vi.fn();

  return {
    window: {
      showErrorMessage,
      showInformationMessage,
    },
    commands: {
      executeCommand,
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: vi.fn((key: string, defaultValue: unknown) => {
          if (key === "provider") return "assemblyai";
          if (key === "assemblyai.apiKey") return "test-api-key";
          if (key === "assemblyai.connectionTimeout") return 2000;
          if (key === "autoStopDelay") return 5;
          if (key === "listeningDelay") return 300;
          if (key === "autoSubmit") return true;
          return defaultValue;
        }),
      })),
    },
    Uri: {
      file: (path: string) => ({ fsPath: path }) as Uri,
    },
  };
});

/**
 * Mock AudioCapturePanel for testing
 */
class MockAudioCapturePanel implements Pick<
  AudioCapturePanel,
  | "start"
  | "stop"
  | "onAudio"
  | "onError"
  | "open"
  | "logTranscript"
  | "logError"
  | "updateStatus"
  | "clearLog"
  | "sendConfigUpdate"
  | "updateLivePreview"
  | "clearLivePreview"
  | "isVisible"
  | "startSession"
  | "endSession"
> {
  private audioHandlers: AudioHandler[] = [];
  private errorHandlers: CaptureErrorHandler[] = [];
  public shouldFailStart = false;
  public isDisposed = false;
  public transcripts: string[] = [];
  public errors: string[] = [];
  public statusUpdates: { status: string; duration?: number }[] = [];
  public logCleared = false;
  public openCalled = false;
  public livePreviewText = "";
  public livePreviewCleared = false;
  public panelVisible = false;
  public sessionStarted = false;
  public sessionEndCalled = false;
  public sessionCancelled: boolean | null = null;

  async start(): Promise<void> {
    if (this.shouldFailStart) {
      throw new Error("Failed to start audio capture");
    }
  }

  stop(): void {
    // no-op for mock
  }

  open(): void {
    this.openCalled = true;
  }

  onAudio(handler: AudioHandler): () => void {
    this.audioHandlers.push(handler);
    return () => {
      const index = this.audioHandlers.indexOf(handler);
      if (index >= 0) this.audioHandlers.splice(index, 1);
    };
  }

  onError(handler: CaptureErrorHandler): () => void {
    this.errorHandlers.push(handler);
    return () => {
      const index = this.errorHandlers.indexOf(handler);
      if (index >= 0) this.errorHandlers.splice(index, 1);
    };
  }

  logTranscript(text: string): void {
    this.transcripts.push(text);
  }

  logError(message: string): void {
    this.errors.push(message);
  }

  updateStatus(status: string, duration?: number): void {
    this.statusUpdates.push({ status, duration });
  }

  clearLog(): void {
    this.logCleared = true;
  }

  updateLivePreview(text: string): void {
    this.livePreviewText = text;
  }

  clearLivePreview(): void {
    this.livePreviewText = "";
    this.livePreviewCleared = true;
  }

  isVisible(): boolean {
    return this.panelVisible;
  }

  sendConfigUpdate(): void {
    // no-op for mock
  }

  startSession(): void {
    this.sessionStarted = true;
  }

  endSession(cancelled: boolean): void {
    this.sessionEndCalled = true;
    this.sessionCancelled = cancelled;
  }

  dispose(): void {
    this.isDisposed = true;
  }

  // Test helpers
  simulateAudio(buffer: ArrayBuffer): void {
    this.audioHandlers.forEach((h) => h(buffer));
  }

  simulateError(error: DictationError): void {
    this.errorHandlers.forEach((h) => h(error));
  }

  reset(): void {
    this.transcripts = [];
    this.errors = [];
    this.statusUpdates = [];
    this.logCleared = false;
    this.openCalled = false;
    this.livePreviewText = "";
    this.livePreviewCleared = false;
    this.panelVisible = false;
    this.sessionStarted = false;
    this.sessionEndCalled = false;
    this.sessionCancelled = null;
  }
}

// Get references to the mocked functions after import
async function getVscodeMocks() {
  const vscode = await import("vscode");
  return {
    showErrorMessage: vi.mocked(vscode.window.showErrorMessage),
    showInformationMessage: vi.mocked(vscode.window.showInformationMessage),
    executeCommand: vi.mocked(vscode.commands.executeCommand),
    getConfiguration: vi.mocked(vscode.workspace.getConfiguration),
  };
}

describe("DictationController", () => {
  let controller: DictationController;
  let mockProvider: MockProvider;
  let mockAudioCapturePanel: MockAudioCapturePanel;
  let mocks: Awaited<ReturnType<typeof getVscodeMocks>>;

  beforeEach(async () => {
    vi.useFakeTimers();

    mocks = await getVscodeMocks();

    mockProvider = new MockProvider();
    mockAudioCapturePanel = new MockAudioCapturePanel();

    controller = new DictationController(
      mockAudioCapturePanel as unknown as AudioCapturePanel,
      () => mockProvider
    );

    // Reset mocks
    mocks.showErrorMessage.mockClear();
    mocks.showInformationMessage.mockClear();
    mocks.executeCommand.mockClear();
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
  });

  // Helper to get recording state details
  function getRecordingState(): Extract<DictationState, { status: "recording" }> | null {
    const state = controller.getState();
    return state.status === "recording" ? state : null;
  }

  describe("basic start/stop", () => {
    it("transitions to recording state with buffering phase on start", async () => {
      // Defer connection to see buffering phase
      mockProvider.deferConnect = true;

      expect(controller.getState().status).toBe("idle");

      await controller.start();

      const state = getRecordingState();
      expect(state).not.toBeNull();
      expect(state?.phase).toBe("buffering");
      expect(state?.isActive).toBe(true); // Always green during buffering

      // Complete connection to clean up
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0);
    });

    it("transitions to idle state on stop", async () => {
      await controller.start();
      expect(controller.getState().status).toBe("recording");

      await controller.stop();

      expect(controller.getState().status).toBe("idle");
    });

    it("inserts transcript text using type command", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      mockProvider.simulateTranscript("Hello world");

      expect(mocks.executeCommand).toHaveBeenCalledWith("type", { text: "Hello world" });
    });
  });

  describe("connection and buffering", () => {
    it("buffers audio during connection", async () => {
      mockProvider.deferConnect = true;

      await controller.start();
      expect(getRecordingState()?.phase).toBe("buffering");

      // Send audio while API is connecting
      const audio1 = new ArrayBuffer(100);
      const audio2 = new ArrayBuffer(200);
      mockAudioCapturePanel.simulateAudio(audio1);
      mockAudioCapturePanel.simulateAudio(audio2);

      // Audio should not be sent yet (provider not connected)
      expect(mockProvider.receivedAudio).toHaveLength(0);

      // Complete connection
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      // Now audio should be sent (in order)
      expect(mockProvider.receivedAudio).toHaveLength(2);
      expect(mockProvider.receivedAudio[0]).toBe(audio1);
      expect(mockProvider.receivedAudio[1]).toBe(audio2);
    });

    it("transitions to streaming phase after connection", async () => {
      mockProvider.deferConnect = true;

      await controller.start();
      expect(getRecordingState()?.phase).toBe("buffering");

      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      expect(getRecordingState()?.phase).toBe("streaming");
    });

    it("shows error on connection timeout", async () => {
      mockProvider.deferConnect = true;

      await controller.start();

      // Advance past connection timeout (2000ms)
      await vi.advanceTimersByTimeAsync(2001);

      expect(controller.getState().status).toBe("error");
      const state = controller.getState();
      if (state.status === "error") {
        expect(state.message).toContain("timeout");
      }
    });

    it("shows error on connection failure", async () => {
      mockProvider.shouldFailConnect = true;

      await controller.start();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      expect(controller.getState().status).toBe("error");
    });
  });

  describe("activity and visual feedback", () => {
    it("shows active (green) during buffering phase regardless of activity", async () => {
      mockProvider.deferConnect = true;

      await controller.start();

      // Should be active during buffering
      expect(getRecordingState()?.isActive).toBe(true);

      // Even after waiting, still active (no listening timer during buffering)
      await vi.advanceTimersByTimeAsync(500);
      expect(getRecordingState()?.isActive).toBe(true);
    });

    it("shows listening (orange) after delay when no activity in streaming phase", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      // Initially might still be active, then after 300ms should show listening
      await vi.advanceTimersByTimeAsync(301);

      expect(getRecordingState()?.isActive).toBe(false);
    });

    it("shows active (green) on activity in streaming phase", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      // Wait for listening timer
      await vi.advanceTimersByTimeAsync(301);
      expect(getRecordingState()?.isActive).toBe(false);

      // Simulate activity
      mockProvider.simulateActivity();

      expect(getRecordingState()?.isActive).toBe(true);
    });

    it("resets listening timer on activity", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      // Wait 200ms (less than listening delay)
      await vi.advanceTimersByTimeAsync(200);

      // Simulate activity - resets the timer
      mockProvider.simulateActivity();

      // Wait another 200ms (400ms total, but only 200ms since last activity)
      await vi.advanceTimersByTimeAsync(200);

      // Should still be active (timer was reset)
      expect(getRecordingState()?.isActive).toBe(true);
    });
  });

  describe("auto-stop timer", () => {
    it("auto-stops after silence timeout with no activity", async () => {
      await controller.start();

      // Wait for 5 seconds (autoStopDelay)
      await vi.advanceTimersByTimeAsync(5001);

      expect(controller.getState().status).toBe("idle");
      expect(mocks.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("No speech detected")
      );
    });

    it("resets auto-stop timer on activity", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      // Wait 4 seconds
      await vi.advanceTimersByTimeAsync(4000);
      expect(controller.getState().status).toBe("recording");

      // Simulate activity - resets timer
      mockProvider.simulateActivity();

      // Wait another 4 seconds (8s total, but only 4s since activity)
      await vi.advanceTimersByTimeAsync(4000);
      expect(controller.getState().status).toBe("recording");

      // Wait 1 more second (5s since activity) - should timeout
      await vi.advanceTimersByTimeAsync(1001);
      expect(controller.getState().status).toBe("idle");
    });

    it("resets auto-stop timer on audio during buffering", async () => {
      // Override config with longer connection timeout for this test
      mocks.getConfiguration.mockReturnValueOnce({
        get: vi.fn((key: string, defaultValue: unknown) => {
          if (key === "assemblyai.apiKey") return "test-api-key";
          if (key === "assemblyai.connectionTimeout") return 10000; // 10s timeout
          if (key === "autoStopDelay") return 5;
          if (key === "listeningDelay") return 300;
          if (key === "autoSubmit") return true;
          return defaultValue;
        }),
      } as unknown as ReturnType<typeof mocks.getConfiguration>);

      mockProvider.deferConnect = true;

      await controller.start();

      // Wait 4 seconds
      await vi.advanceTimersByTimeAsync(4000);
      expect(controller.getState().status).toBe("recording");

      // Send audio - resets timer
      mockAudioCapturePanel.simulateAudio(new ArrayBuffer(100));

      // Wait another 4 seconds
      await vi.advanceTimersByTimeAsync(4000);
      expect(controller.getState().status).toBe("recording");

      // Wait 1 more second (5s since audio) - should timeout
      await vi.advanceTimersByTimeAsync(1001);
      expect(controller.getState().status).toBe("idle");
    });

    it("resets both auto-stop and listening timers on activity", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      // Wait for listening timer
      await vi.advanceTimersByTimeAsync(301);
      expect(getRecordingState()?.isActive).toBe(false);

      // Wait close to auto-stop timeout
      await vi.advanceTimersByTimeAsync(4500);

      // Simulate activity - should reset BOTH timers
      mockProvider.simulateActivity();

      // Should be active again
      expect(getRecordingState()?.isActive).toBe(true);

      // Should still be recording (auto-stop was reset)
      await vi.advanceTimersByTimeAsync(4000);
      expect(controller.getState().status).toBe("recording");
    });
  });

  describe("auto-submit feature", () => {
    it("emits Enter on manual stop (toggle) when autoSubmit is enabled", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      await controller.toggle(); // Manual stop

      expect(mocks.executeCommand).toHaveBeenCalledWith("type", { text: "\n" });
    });

    it("does not emit Enter on auto-stop (silence timeout)", async () => {
      await controller.start();

      // Wait for auto-stop
      await vi.advanceTimersByTimeAsync(5001);

      expect(mocks.executeCommand).not.toHaveBeenCalledWith("type", { text: "\n" });
    });

    it("does not emit Enter on error", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      mockProvider.simulateError({ type: "connection", message: "Lost connection" });

      expect(mocks.executeCommand).not.toHaveBeenCalledWith("type", { text: "\n" });
    });

    it("does not emit Enter when autoSubmit is disabled", async () => {
      // Override config to disable autoSubmit
      mocks.getConfiguration.mockReturnValueOnce({
        get: vi.fn((key: string, defaultValue: unknown) => {
          if (key === "autoSubmit") return false;
          if (key === "assemblyai.apiKey") return "test-api-key";
          if (key === "assemblyai.connectionTimeout") return 2000;
          if (key === "autoStopDelay") return 5;
          if (key === "listeningDelay") return 300;
          return defaultValue;
        }),
      } as unknown as ReturnType<typeof mocks.getConfiguration>);

      await controller.start();
      await controller.toggle(); // Manual stop

      expect(mocks.executeCommand).not.toHaveBeenCalledWith("type", { text: "\n" });
    });
  });

  describe("error handling", () => {
    it("transitions to error state on provider error", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      mockProvider.simulateError({ type: "auth", message: "Invalid key" });

      const state = controller.getState();
      expect(state.status).toBe("error");
    });

    it("transitions to error state on audio capture error", async () => {
      await controller.start();

      mockAudioCapturePanel.simulateError({
        type: "permission",
        message: "Microphone access denied",
      });

      expect(controller.getState().status).toBe("error");
    });

    it("error state notifies handlers (for StatusBar auto-clear)", async () => {
      // This test verifies that error state is properly communicated to handlers
      // which allows StatusBar to implement its 3-second auto-clear timer
      const stateChanges: DictationState[] = [];
      controller.onStateChange((state) => stateChanges.push(state));

      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      mockProvider.simulateError({ type: "connection", message: "Lost connection" });

      // Find the error state in changes
      const errorState = stateChanges.find((s) => s.status === "error");
      expect(errorState).toBeDefined();
      expect(errorState?.status).toBe("error");
      if (errorState?.status === "error") {
        expect(errorState.message).toContain("Connection lost");
      }
    });
  });

  describe("loading state", () => {
    it("shows notification when toggling during loading", async () => {
      mockProvider.deferConnect = true;
      mockAudioCapturePanel.shouldFailStart = false;

      // Start but simulate slow audio capture start
      const originalStart = mockAudioCapturePanel.start.bind(mockAudioCapturePanel);
      let resolveStart: () => void;
      mockAudioCapturePanel.start = () =>
        new Promise((resolve) => {
          resolveStart = () => {
            resolve();
          };
        });

      const startPromise = controller.start();

      // Should be in loading state
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.getState().status).toBe("loading");

      // Try to toggle during loading
      await controller.toggle();

      expect(mocks.showInformationMessage).toHaveBeenCalledWith("Dictation: Already connecting...");

      // Cleanup: restore and complete
      mockAudioCapturePanel.start = originalStart;
      resolveStart!();
      await startPromise;
    });
  });

  describe("no API key", () => {
    it("shows error and stays idle when no API key configured", async () => {
      mocks.getConfiguration.mockReturnValueOnce({
        get: vi.fn((key: string, defaultValue: unknown) => {
          if (key === "assemblyai.apiKey") return "";
          return defaultValue;
        }),
      } as unknown as ReturnType<typeof mocks.getConfiguration>);

      await controller.start();

      expect(controller.getState().status).toBe("idle");
      expect(mocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("No API key configured")
      );
    });

    it("opens settings when toggle is called without API key", async () => {
      mocks.getConfiguration.mockReturnValueOnce({
        get: vi.fn((key: string, defaultValue: unknown) => {
          if (key === "assemblyai.apiKey") return "";
          return defaultValue;
        }),
      } as unknown as ReturnType<typeof mocks.getConfiguration>);

      await controller.toggle();

      expect(controller.getState().status).toBe("idle");
      expect(mocks.executeCommand).toHaveBeenCalledWith(
        "workbench.action.openSettings",
        "codehydra.dictation"
      );
    });
  });

  describe("panel logging", () => {
    it("logs transcript to panel via logTranscript()", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      mockProvider.simulateTranscript("Hello world");

      expect(mockAudioCapturePanel.transcripts).toContain("Hello world");
    });

    it("logs error to panel via logError()", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      mockProvider.simulateError({ type: "connection", message: "Lost connection" });

      expect(mockAudioCapturePanel.errors.length).toBeGreaterThan(0);
      expect(mockAudioCapturePanel.errors[0]).toContain("Connection lost");
    });

    it("updates status via updateStatus()", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      // Status updates are called during state transitions
      expect(mockAudioCapturePanel.statusUpdates.length).toBeGreaterThan(0);

      await controller.stop();

      // Should have "Ready" status after stop
      const lastStatus =
        mockAudioCapturePanel.statusUpdates[mockAudioCapturePanel.statusUpdates.length - 1];
      expect(lastStatus.status).toBe("Ready");
    });

    it("tab stays open after recording stops", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      await controller.stop();

      // Panel should not be disposed
      expect(mockAudioCapturePanel.isDisposed).toBe(false);
      expect(controller.getState().status).toBe("idle");
    });
  });

  describe("terminal text insertion", () => {
    it("inserts transcript into terminal when no editor is active", async () => {
      const vscode = await import("vscode");
      const mockTerminal = { sendText: vi.fn() };

      Object.defineProperty(vscode.window, "activeTextEditor", {
        value: undefined,
        configurable: true,
      });
      Object.defineProperty(vscode.window, "activeTerminal", {
        value: mockTerminal,
        configurable: true,
      });

      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      mockProvider.simulateTranscript("hello world");

      expect(mockTerminal.sendText).toHaveBeenCalledWith("hello world", false);
      expect(mocks.executeCommand).not.toHaveBeenCalledWith("type", { text: "hello world" });
    });
  });

  describe("rapid toggle", () => {
    it("handles rapid toggle without crashing", async () => {
      const p1 = controller.toggle();
      const p2 = controller.toggle();
      const p3 = controller.toggle();

      await Promise.all([p1, p2, p3]);

      // Should be in a consistent state
      const state = controller.getState();
      expect(["idle", "recording", "loading", "stopping", "error"]).toContain(state.status);
    });
  });

  describe("live preview", () => {
    it("sends partial transcripts to live preview", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      mockProvider.simulatePartialTranscript("Hello");

      expect(mockAudioCapturePanel.livePreviewText).toBe("Hello");
    });

    it("clears live preview when final transcript is received", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      mockProvider.simulatePartialTranscript("Hello world");
      expect(mockAudioCapturePanel.livePreviewText).toBe("Hello world");

      mockProvider.simulateTranscript("Hello world ");
      expect(mockAudioCapturePanel.livePreviewCleared).toBe(true);
    });

    it("clears live preview when recording stops", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      mockProvider.simulatePartialTranscript("Hello");

      await controller.stop();

      expect(mockAudioCapturePanel.livePreviewCleared).toBe(true);
    });
  });

  describe("smart output (visibility-based)", () => {
    beforeEach(async () => {
      // Reset window properties to ensure type command is used (not terminal)
      const vscode = await import("vscode");
      Object.defineProperty(vscode.window, "activeTextEditor", {
        value: { document: {} },
        configurable: true,
      });
      Object.defineProperty(vscode.window, "activeTerminal", {
        value: undefined,
        configurable: true,
      });
    });

    it("does not emit text when panel is visible", async () => {
      mockAudioCapturePanel.panelVisible = true;

      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      mockProvider.simulateTranscript("Hello world");

      // Transcript should be logged but NOT emitted
      expect(mockAudioCapturePanel.transcripts).toContain("Hello world");
      expect(mocks.executeCommand).not.toHaveBeenCalledWith("type", { text: "Hello world" });
    });

    it("emits text when panel is not visible", async () => {
      mockAudioCapturePanel.panelVisible = false;

      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      mockProvider.simulateTranscript("Hello world");

      // Transcript should be logged AND emitted
      expect(mockAudioCapturePanel.transcripts).toContain("Hello world");
      expect(mocks.executeCommand).toHaveBeenCalledWith("type", { text: "Hello world" });
    });

    it("does not emit Enter when panel is visible (manual stop)", async () => {
      mockAudioCapturePanel.panelVisible = true;

      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      await controller.toggle(); // Manual stop with autoSubmit enabled

      expect(mocks.executeCommand).not.toHaveBeenCalledWith("type", { text: "\n" });
    });

    it("emits Enter when panel is not visible (manual stop)", async () => {
      mockAudioCapturePanel.panelVisible = false;

      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      await controller.toggle(); // Manual stop with autoSubmit enabled

      expect(mocks.executeCommand).toHaveBeenCalledWith("type", { text: "\n" });
    });
  });

  describe("session management", () => {
    it("starts a new session when recording begins", async () => {
      expect(mockAudioCapturePanel.sessionStarted).toBe(false);

      await controller.start();

      expect(mockAudioCapturePanel.sessionStarted).toBe(true);
    });

    it("ends session with cancelled=false on normal stop (toggle)", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      expect(mockAudioCapturePanel.sessionEndCalled).toBe(false);

      await controller.toggle(); // Normal stop

      expect(mockAudioCapturePanel.sessionEndCalled).toBe(true);
      expect(mockAudioCapturePanel.sessionCancelled).toBe(false);
    });

    it("ends session with cancelled=true on cancel (Escape)", async () => {
      await controller.start();
      mockProvider.completeConnect();
      await vi.advanceTimersByTimeAsync(0); // Flush promises

      expect(mockAudioCapturePanel.sessionEndCalled).toBe(false);

      await controller.cancel(); // Cancel with Escape

      expect(mockAudioCapturePanel.sessionEndCalled).toBe(true);
      expect(mockAudioCapturePanel.sessionCancelled).toBe(true);
    });

    it("ends session with cancelled=false on auto-stop", async () => {
      await controller.start();

      // Wait for auto-stop (5 seconds)
      await vi.advanceTimersByTimeAsync(5001);

      expect(mockAudioCapturePanel.sessionEndCalled).toBe(true);
      expect(mockAudioCapturePanel.sessionCancelled).toBe(false);
    });
  });
});
