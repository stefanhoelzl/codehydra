import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Uri, WebviewPanel, Webview, Disposable } from "vscode";

// Track mock function calls
const mockCreateWebviewPanel = vi.fn();
const mockExecuteCommand = vi.fn();
let mockIsConfigured = true;

// Mock vscode module
vi.mock("vscode", () => {
  return {
    window: {
      createWebviewPanel: (...args: unknown[]) => mockCreateWebviewPanel(...args),
    },
    commands: {
      executeCommand: (...args: unknown[]) => mockExecuteCommand(...args),
    },
    ViewColumn: {
      One: 1,
      Two: 2,
      Beside: -2,
    },
    Uri: {
      file: (path: string) => ({ fsPath: path }) as Uri,
    },
  };
});

// Mock config module
vi.mock("../config", () => ({
  isConfigured: () => mockIsConfigured,
}));

// Mock fs module
vi.mock("fs", () => ({
  readFileSync: vi.fn(() => "<html>{{processorCode}}{{codiconsUri}}</html>"),
}));

import { AudioCapturePanel } from "./AudioCapturePanel";

interface MockWebviewPanel extends WebviewPanel {
  disposed: boolean;
  simulateMessage: (message: unknown) => void;
  simulateDispose: () => void;
}

/**
 * Creates a mock WebviewPanel
 */
function createMockPanel(): MockWebviewPanel {
  const disposables: Disposable[] = [];
  const messageHandlers: ((message: unknown) => void)[] = [];
  const disposeHandlers: (() => void)[] = [];
  let disposed = false;

  const panel: MockWebviewPanel = {
    disposed,
    visible: true, // Panel is visible by default when created
    viewType: "test",
    title: "Test",
    webview: {
      html: "",
      options: {},
      onDidReceiveMessage: (handler: (message: unknown) => void) => {
        messageHandlers.push(handler);
        const disposable = { dispose: () => {} };
        disposables.push(disposable);
        return disposable;
      },
      postMessage: vi.fn().mockResolvedValue(true),
      asWebviewUri: (uri: Uri) => ({ toString: () => `vscode-webview://${uri.fsPath}` }),
    } as unknown as Webview,
    onDidDispose: (handler: () => void) => {
      disposeHandlers.push(handler);
      const disposable = { dispose: () => {} };
      disposables.push(disposable);
      return disposable;
    },
    onDidChangeViewState: vi.fn(() => ({ dispose: () => {} })),
    reveal: vi.fn(),
    dispose: () => {
      disposed = true;
      panel.disposed = true;
      disposeHandlers.forEach((h) => h());
    },
    // Test helpers
    simulateMessage: (message: unknown) => {
      messageHandlers.forEach((h) => h(message));
    },
    simulateDispose: () => {
      disposeHandlers.forEach((h) => h());
    },
  } as unknown as MockWebviewPanel;

  return panel;
}

describe("AudioCapturePanel", () => {
  let extensionUri: Uri;
  let mockPanel: MockWebviewPanel;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConfigured = true;

    extensionUri = { fsPath: "/test/extension" } as Uri;
    mockPanel = createMockPanel();
    mockCreateWebviewPanel.mockReturnValue(mockPanel);

    // Reset singleton
    // @ts-expect-error - accessing private static for testing
    AudioCapturePanel.instance = null;
  });

  afterEach(() => {
    // Clean up singleton
    // @ts-expect-error - accessing private static for testing
    if (AudioCapturePanel.instance) {
      AudioCapturePanel.getInstance(extensionUri).dispose();
    }
  });

  describe("open()", () => {
    it("does nothing when isConfigured() returns false", () => {
      mockIsConfigured = false;

      const panel = AudioCapturePanel.getInstance(extensionUri);
      panel.open();

      expect(mockCreateWebviewPanel).not.toHaveBeenCalled();
    });

    it("creates panel with ViewColumn.One and preserveFocus: true", () => {
      const panel = AudioCapturePanel.getInstance(extensionUri);
      panel.open();

      expect(mockCreateWebviewPanel).toHaveBeenCalledWith(
        AudioCapturePanel.viewType,
        "Dictate",
        {
          viewColumn: 1, // ViewColumn.One
          preserveFocus: true,
        },
        expect.objectContaining({
          enableScripts: true,
          retainContextWhenHidden: true,
        })
      );
    });

    it("does not create panel again if already open", () => {
      const panel = AudioCapturePanel.getInstance(extensionUri);
      panel.open();
      panel.open();
      panel.open();

      expect(mockCreateWebviewPanel).toHaveBeenCalledTimes(1);
    });

    it("recreates panel after it is closed", () => {
      const panel = AudioCapturePanel.getInstance(extensionUri);
      panel.open();

      expect(mockCreateWebviewPanel).toHaveBeenCalledTimes(1);

      // Simulate user closing the tab
      mockPanel.simulateDispose();

      // Create a new mock for the next panel
      const newMockPanel = createMockPanel();
      mockCreateWebviewPanel.mockReturnValue(newMockPanel);

      // Open again
      panel.open();

      expect(mockCreateWebviewPanel).toHaveBeenCalledTimes(2);
    });
  });

  describe("isDisposing flag", () => {
    it("prevents operations during disposal", async () => {
      const panel = AudioCapturePanel.getInstance(extensionUri);
      panel.open();

      // @ts-expect-error - accessing private for testing
      panel.isDisposing = true;

      // Try to start - should throw
      await expect(panel.start()).rejects.toThrow("Panel is being disposed");
    });

    it("prevents open() during disposal", () => {
      const panel = AudioCapturePanel.getInstance(extensionUri);
      panel.open();

      expect(mockCreateWebviewPanel).toHaveBeenCalledTimes(1);

      // Simulate disposal in progress
      // @ts-expect-error - accessing private for testing
      panel.isDisposing = true;

      // Try to open - should be no-op
      panel.open();

      expect(mockCreateWebviewPanel).toHaveBeenCalledTimes(1);
    });

    it("prevents message handling during disposal", () => {
      const panel = AudioCapturePanel.getInstance(extensionUri);
      panel.open();

      const audioHandler = vi.fn();
      panel.onAudio(audioHandler);

      // @ts-expect-error - accessing private for testing
      panel.isDisposing = true;

      // Simulate audio message - should be ignored
      mockPanel.simulateMessage({ type: "audio", data: [1, 2, 3] });

      expect(audioHandler).not.toHaveBeenCalled();
    });

    it("is reset after panel disposal completes", () => {
      const panel = AudioCapturePanel.getInstance(extensionUri);
      panel.open();

      // Simulate user closing the tab
      mockPanel.simulateDispose();

      // @ts-expect-error - accessing private for testing
      expect(panel.isDisposing).toBe(false);
    });
  });

  describe("openSettings message", () => {
    it("executes openSettings command when message received", () => {
      const panel = AudioCapturePanel.getInstance(extensionUri);
      panel.open();

      mockPanel.simulateMessage({ type: "openSettings" });

      expect(mockExecuteCommand).toHaveBeenCalledWith(
        "workbench.action.openSettings",
        "codehydra.dictation"
      );
    });
  });

  describe("isVisible()", () => {
    it("returns false when panel is not open", () => {
      const panel = AudioCapturePanel.getInstance(extensionUri);
      // Panel not opened yet
      expect(panel.isVisible()).toBe(false);
    });

    it("returns panel visibility state when open", () => {
      const panel = AudioCapturePanel.getInstance(extensionUri);
      panel.open();

      // Panel starts visible (initial state from mock)
      // The mock's visible property is accessed during createPanel
      expect(panel.isVisible()).toBe(true); // Initial state from mock
    });
  });

  describe("updateLivePreview()", () => {
    it("sends livePreview message to webview", () => {
      const panel = AudioCapturePanel.getInstance(extensionUri);
      panel.open();

      panel.updateLivePreview("Hello world");

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith({
        type: "livePreview",
        text: "Hello world",
      });
    });
  });

  describe("clearLivePreview()", () => {
    it("sends livePreview message with empty text", () => {
      const panel = AudioCapturePanel.getInstance(extensionUri);
      panel.open();

      panel.clearLivePreview();

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith({
        type: "livePreview",
        text: "",
      });
    });
  });

  describe("startSession()", () => {
    it("sends sessionStart message with timestamp", () => {
      const panel = AudioCapturePanel.getInstance(extensionUri);
      panel.open();

      const beforeTime = Date.now();
      panel.startSession();
      const afterTime = Date.now();

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "sessionStart",
          timestamp: expect.any(Number),
        })
      );

      // Verify timestamp is reasonable
      const call = vi
        .mocked(mockPanel.webview.postMessage)
        .mock.calls.find((c) => (c[0] as { type: string }).type === "sessionStart");
      expect(call).toBeDefined();
      const msg = call![0] as { type: string; timestamp: number };
      expect(msg.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(msg.timestamp).toBeLessThanOrEqual(afterTime);
    });
  });

  describe("endSession()", () => {
    it("sends sessionEnd message with cancelled=false for normal stop", () => {
      const panel = AudioCapturePanel.getInstance(extensionUri);
      panel.open();

      panel.endSession(false);

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith({
        type: "sessionEnd",
        cancelled: false,
      });
    });

    it("sends sessionEnd message with cancelled=true for cancelled stop", () => {
      const panel = AudioCapturePanel.getInstance(extensionUri);
      panel.open();

      panel.endSession(true);

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith({
        type: "sessionEnd",
        cancelled: true,
      });
    });
  });
});
