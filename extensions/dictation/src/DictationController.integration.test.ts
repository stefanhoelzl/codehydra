import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Uri } from "vscode";
import { MockProvider } from "./providers/mock";
import type { DictationError } from "./providers/types";
import type {
  AudioCaptureViewProvider,
  AudioHandler,
  CaptureErrorHandler,
} from "./audio/AudioCaptureViewProvider";
import { DictationController } from "./DictationController";

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
          if (key === "silenceTimeout") return 10;
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
 * Mock AudioCaptureViewProvider for testing
 */
class MockAudioCaptureProvider implements Pick<
  AudioCaptureViewProvider,
  "start" | "stop" | "onAudio" | "onError"
> {
  private audioHandlers: AudioHandler[] = [];
  private errorHandlers: CaptureErrorHandler[] = [];
  public shouldFailStart = false;

  async start(): Promise<void> {
    if (this.shouldFailStart) {
      throw new Error("Failed to start audio capture");
    }
  }

  stop(): void {
    // no-op for mock
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

  // Test helpers
  simulateAudio(buffer: ArrayBuffer): void {
    this.audioHandlers.forEach((h) => h(buffer));
  }

  simulateError(error: DictationError): void {
    this.errorHandlers.forEach((h) => h(error));
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
  let mockAudioCaptureProvider: MockAudioCaptureProvider;
  let mocks: Awaited<ReturnType<typeof getVscodeMocks>>;

  beforeEach(async () => {
    vi.useFakeTimers();

    mocks = await getVscodeMocks();

    mockProvider = new MockProvider();
    mockAudioCaptureProvider = new MockAudioCaptureProvider();

    controller = new DictationController(
      mockAudioCaptureProvider as unknown as AudioCaptureViewProvider,
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

  // Test 1: Start recording
  it("transitions to recording state on successful start", async () => {
    expect(controller.getState().status).toBe("idle");

    await controller.start();

    expect(controller.getState().status).toBe("recording");
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "codehydra.dictation.isRecording",
      true
    );
  });

  // Test 2: Stop recording
  it("transitions to idle state on stop and calls cleanup", async () => {
    await controller.start();
    expect(controller.getState().status).toBe("recording");

    await controller.stop();

    expect(controller.getState().status).toBe("idle");
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "codehydra.dictation.isRecording",
      false
    );
  });

  // Test 3: Transcript received
  it("inserts transcript text using type command", async () => {
    await controller.start();

    mockProvider.simulateTranscript("Hello world");

    // The type command should have been called to insert text at cursor
    expect(mocks.executeCommand).toHaveBeenCalledWith("type", { text: "Hello world" });
  });

  // Test 4: Connection error
  it("shows error notification and returns to idle on connection failure", async () => {
    mockProvider.shouldFailConnect = true;

    await controller.start();

    expect(controller.getState().status).toBe("idle");
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Failed to connect")
    );
  });

  // Test 5: Connection lost
  it("shows error notification and returns to idle on connection loss", async () => {
    await controller.start();
    expect(controller.getState().status).toBe("recording");

    mockProvider.simulateClose();

    expect(controller.getState().status).toBe("idle");
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Connection lost"));
  });

  // Test 6: Silence timeout
  it("auto-stops and shows notification when silence timeout reached", async () => {
    await controller.start();
    expect(controller.getState().status).toBe("recording");

    // Fast-forward 10 seconds (default silenceTimeout) with no transcripts
    await vi.advanceTimersByTimeAsync(10000);

    expect(controller.getState().status).toBe("idle");
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("No speech detected")
    );
  });

  // Test 6b: Silence timer resets on transcript
  it("resets silence timer when transcript received", async () => {
    await controller.start();
    expect(controller.getState().status).toBe("recording");

    // Wait 8 seconds (not enough to trigger timeout)
    await vi.advanceTimersByTimeAsync(8000);
    expect(controller.getState().status).toBe("recording");

    // Receive a transcript - this should reset the timer
    mockProvider.simulateTranscript("hello");

    // Wait another 8 seconds (16s total, but only 8s since last transcript)
    await vi.advanceTimersByTimeAsync(8000);
    expect(controller.getState().status).toBe("recording");

    // Wait 2 more seconds (10s since last transcript) - should now timeout
    await vi.advanceTimersByTimeAsync(2000);
    expect(controller.getState().status).toBe("idle");
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("No speech detected")
    );
  });

  // Test 7: No API key
  it("shows error and stays idle when no API key configured", async () => {
    // Override config to return empty API key
    mocks.getConfiguration.mockReturnValueOnce({
      get: vi.fn((key: string, defaultValue: unknown) => {
        if (key === "assemblyai.apiKey") return "";
        if (key === "silenceTimeout") return 10;
        return defaultValue;
      }),
    } as unknown as ReturnType<typeof mocks.getConfiguration>);

    await controller.start();

    expect(controller.getState().status).toBe("idle");
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("No API key configured")
    );
  });

  // Test 8: Permission denied (formerly Test 9)
  it("shows error and returns to idle on microphone permission denied", async () => {
    await controller.start();
    expect(controller.getState().status).toBe("recording");

    mockAudioCaptureProvider.simulateError({
      type: "permission",
      message: "Microphone access denied",
    });

    expect(controller.getState().status).toBe("idle");
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Microphone access denied")
    );
  });

  // Test 10: Rapid toggle
  it("handles rapid toggle without crashing", async () => {
    // Toggle quickly 3 times
    const p1 = controller.toggle();
    const p2 = controller.toggle();
    const p3 = controller.toggle();

    await Promise.all([p1, p2, p3]);

    // Should be in a consistent state (not crashed)
    const state = controller.getState();
    expect(["idle", "recording", "starting", "stopping"]).toContain(state.status);
  });

  // Test 11: Toggle during starting
  it("shows notification and ignores toggle during starting state", async () => {
    // Make provider defer connection until we call completeConnect()
    mockProvider.deferConnect = true;

    // Start connection (will be in 'starting' state)
    const startPromise = controller.start();

    // Allow microtasks to run so state transitions to 'starting'
    await Promise.resolve();
    expect(controller.getState().status).toBe("starting");

    // Try to toggle while starting
    await controller.toggle();

    expect(mocks.showInformationMessage).toHaveBeenCalledWith("Dictation: Already connecting...");

    // Complete the connection
    mockProvider.completeConnect();
    await startPromise;
  });

  // Test 12: Auth error notification
  it("shows auth error notification", async () => {
    await controller.start();

    mockProvider.simulateError({ type: "auth", message: "Invalid API key" });

    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      "Dictation: Invalid API key. Please check your settings."
    );
  });

  // Test 13: Quota error notification
  it("shows quota error notification", async () => {
    await controller.start();

    mockProvider.simulateError({ type: "quota", message: "Rate limit exceeded" });

    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      "Dictation: API quota exceeded. Rate limit exceeded"
    );
  });

  // Test 14: Provider error notification
  it("shows provider error notification", async () => {
    await controller.start();

    mockProvider.simulateError({ type: "provider", code: 500, message: "Server error" });

    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      "Dictation: Error from speech service. Server error"
    );
  });

  // Test 15: Terminal text insertion
  it("inserts transcript into terminal when no editor is active", async () => {
    // Import vscode to access the mock
    const vscode = await import("vscode");
    const mockTerminal = { sendText: vi.fn() };

    // Override activeTextEditor and activeTerminal
    Object.defineProperty(vscode.window, "activeTextEditor", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(vscode.window, "activeTerminal", {
      value: mockTerminal,
      configurable: true,
    });

    await controller.start();

    mockProvider.simulateTranscript("hello world");

    expect(mockTerminal.sendText).toHaveBeenCalledWith("hello world", false);
    expect(mocks.executeCommand).not.toHaveBeenCalledWith("type", expect.anything());
  });

  // Test 16: Audio forwarding
  it("forwards audio from capture to provider", async () => {
    await controller.start();

    const audioData = new ArrayBuffer(100);
    mockAudioCaptureProvider.simulateAudio(audioData);

    expect(mockProvider.receivedAudio).toContain(audioData);
  });
});
