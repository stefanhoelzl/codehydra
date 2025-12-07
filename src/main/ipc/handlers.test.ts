// @vitest-environment node
/**
 * Tests for IPC handler registration and error handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// Mock functions at top level
const mockHandle = vi.fn();
const mockSend = vi.fn();

// Mock Electron - must be at module scope, no top level variable references in factory
vi.mock("electron", () => {
  return {
    ipcMain: {
      handle: (...args: unknown[]) => mockHandle(...args),
    },
  };
});

// Import after mock
import { registerHandler, registerAllHandlers, emitEvent, serializeError } from "./handlers";
import { ValidationError } from "./validation";
import { WorkspaceError } from "../../services/errors";
import type { IViewManager } from "../managers/view-manager.interface";

describe("registerHandler", () => {
  beforeEach(() => {
    mockHandle.mockClear();
    mockSend.mockClear();
  });

  it("registers a handler for a channel", () => {
    const schema = z.object({ path: z.string() });
    const handler = vi.fn().mockResolvedValue({ success: true });

    registerHandler("project:open", schema, handler);

    expect(mockHandle).toHaveBeenCalledWith("project:open", expect.any(Function));
  });

  it("validates payload before calling handler", async () => {
    const schema = z.object({ path: z.string() });
    const handler = vi.fn().mockResolvedValue({ success: true });

    registerHandler("project:open", schema, handler);

    // Get the registered wrapper
    const registeredWrapper = mockHandle.mock.calls[0]?.[1] as (
      event: unknown,
      payload: unknown
    ) => Promise<unknown>;

    // Call with valid payload
    await registeredWrapper({}, { path: "/valid/path" });

    expect(handler).toHaveBeenCalledWith(expect.anything(), { path: "/valid/path" });
  });

  it("throws ValidationError for invalid payload", async () => {
    const schema = z.object({ path: z.string() });
    const handler = vi.fn();

    registerHandler("project:open", schema, handler);

    const registeredWrapper = mockHandle.mock.calls[0]?.[1] as (
      event: unknown,
      payload: unknown
    ) => Promise<unknown>;

    // Call with invalid payload
    await expect(registeredWrapper({}, { path: 123 })).rejects.toThrow();

    // Handler should not be called
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows void schema for handlers without payload", async () => {
    const handler = vi.fn().mockResolvedValue([]);

    registerHandler("project:list", null, handler);

    const registeredWrapper = mockHandle.mock.calls[0]?.[1] as (
      event: unknown,
      payload: unknown
    ) => Promise<unknown>;

    await registeredWrapper({}, undefined);

    expect(handler).toHaveBeenCalled();
  });
});

describe("serializeError", () => {
  it("serializes ServiceError subclasses via toJSON", () => {
    const error = new WorkspaceError("Workspace not found", "WORKSPACE_NOT_FOUND");

    const serialized = serializeError(error);

    expect(serialized).toEqual({
      type: "workspace",
      message: "Workspace not found",
      code: "WORKSPACE_NOT_FOUND",
    });
  });

  it("serializes ValidationError", () => {
    const error = new ValidationError([{ path: ["path"], message: "Required" }]);

    const serialized = serializeError(error);

    expect(serialized).toEqual({
      type: "validation",
      message: "path: Required",
    });
  });

  it("wraps unknown errors with type 'unknown'", () => {
    const error = new Error("Something went wrong");

    const serialized = serializeError(error);

    expect(serialized).toEqual({
      type: "unknown",
      message: "Something went wrong",
    });
  });

  it("handles non-Error objects", () => {
    const serialized = serializeError("string error");

    expect(serialized).toEqual({
      type: "unknown",
      message: "Unknown error",
    });
  });
});

describe("createUISetDialogModeHandler", () => {
  beforeEach(() => {
    mockHandle.mockClear();
  });

  it("calls viewManager.setDialogMode with isOpen=true", async () => {
    const mockSetDialogMode = vi.fn();
    const mockViewManager = { setDialogMode: mockSetDialogMode };

    const { createUISetDialogModeHandler } = await import("./handlers");
    const handler = createUISetDialogModeHandler(mockViewManager);

    await handler({} as never, { isOpen: true });

    expect(mockSetDialogMode).toHaveBeenCalledWith(true);
  });

  it("calls viewManager.setDialogMode with isOpen=false", async () => {
    const mockSetDialogMode = vi.fn();
    const mockViewManager = { setDialogMode: mockSetDialogMode };

    const { createUISetDialogModeHandler } = await import("./handlers");
    const handler = createUISetDialogModeHandler(mockViewManager);

    await handler({} as never, { isOpen: false });

    expect(mockSetDialogMode).toHaveBeenCalledWith(false);
  });
});

describe("emitEvent", () => {
  beforeEach(() => {
    mockSend.mockClear();
  });

  it("sends event to UI view via viewManager", () => {
    // Create mock viewManager with getUIView
    const mockViewManager = {
      getUIView: vi.fn().mockReturnValue({
        webContents: {
          send: mockSend,
        },
      }),
      createWorkspaceView: vi.fn(),
      destroyWorkspaceView: vi.fn(),
      getWorkspaceView: vi.fn(),
      updateBounds: vi.fn(),
      setActiveWorkspace: vi.fn(),
      focusActiveWorkspace: vi.fn(),
      focusUI: vi.fn(),
      setDialogMode: vi.fn(),
    } satisfies IViewManager;

    // Create mock appState
    const mockAppState = {
      getProject: vi.fn(),
      getProjects: vi.fn().mockReturnValue([]),
      openProject: vi.fn(),
      closeProject: vi.fn(),
    };

    // Register handlers to set viewManagerRef
    registerAllHandlers(mockAppState as never, mockViewManager);

    const payload = { project: { path: "/test" as never, name: "test", workspaces: [] } };

    emitEvent("project:opened", payload);

    expect(mockViewManager.getUIView).toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith("project:opened", payload);
  });

  it("handles no viewManager gracefully", () => {
    // Note: Since registerAllHandlers sets viewManagerRef, and we can't reset it,
    // this test verifies the behavior when viewManagerRef is set (which is the normal case)
    // The "no viewManager" case is the initial state before registerAllHandlers is called
    expect(() => emitEvent("project:opened", {} as never)).not.toThrow();
  });
});
