/**
 * Integration tests for IpcLayer using behavioral mock.
 *
 * These tests verify the IpcLayer interface contract using the behavioral mock.
 * The boundary tests verify the same behavior against real Electron ipcMain.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createBehavioralIpcLayer, type BehavioralIpcLayer } from "./ipc.test-utils";
import { PlatformError } from "./errors";

describe("IpcLayer.handle", () => {
  let ipcLayer: BehavioralIpcLayer;

  beforeEach(() => {
    ipcLayer = createBehavioralIpcLayer();
  });

  it("registers handler for channel", () => {
    const handler = async () => "result";
    ipcLayer.handle("api:test:channel", handler);

    const state = ipcLayer._getState();
    expect(state.handlers.has("api:test:channel")).toBe(true);
  });

  it("throws PlatformError on duplicate registration", () => {
    ipcLayer.handle("api:test:channel", async () => "first");

    expect(() => ipcLayer.handle("api:test:channel", async () => "second")).toThrow(PlatformError);
  });

  it("duplicate registration has correct error code", () => {
    ipcLayer.handle("api:test:channel", async () => "first");

    try {
      ipcLayer.handle("api:test:channel", async () => "second");
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe("IPC_HANDLER_EXISTS");
    }
  });

  it("allows different channels", () => {
    ipcLayer.handle("api:test:one", async () => "one");
    ipcLayer.handle("api:test:two", async () => "two");

    const state = ipcLayer._getState();
    expect(state.handlers.size).toBe(2);
    expect(state.handlers.has("api:test:one")).toBe(true);
    expect(state.handlers.has("api:test:two")).toBe(true);
  });
});

describe("IpcLayer.removeHandler", () => {
  let ipcLayer: BehavioralIpcLayer;

  beforeEach(() => {
    ipcLayer = createBehavioralIpcLayer();
  });

  it("removes registered handler", () => {
    ipcLayer.handle("api:test:channel", async () => "result");
    ipcLayer.removeHandler("api:test:channel");

    const state = ipcLayer._getState();
    expect(state.handlers.has("api:test:channel")).toBe(false);
  });

  it("throws PlatformError for non-existent channel", () => {
    expect(() => ipcLayer.removeHandler("api:nonexistent")).toThrow(PlatformError);
  });

  it("non-existent removal has correct error code", () => {
    try {
      ipcLayer.removeHandler("api:nonexistent");
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe("IPC_HANDLER_NOT_FOUND");
    }
  });

  it("allows re-registration after removal", () => {
    ipcLayer.handle("api:test:channel", async () => "first");
    ipcLayer.removeHandler("api:test:channel");
    ipcLayer.handle("api:test:channel", async () => "second");

    const state = ipcLayer._getState();
    expect(state.handlers.has("api:test:channel")).toBe(true);
  });
});

describe("IpcLayer.removeAllHandlers", () => {
  let ipcLayer: BehavioralIpcLayer;

  beforeEach(() => {
    ipcLayer = createBehavioralIpcLayer();
  });

  it("removes all handlers", () => {
    ipcLayer.handle("api:test:one", async () => "one");
    ipcLayer.handle("api:test:two", async () => "two");
    ipcLayer.handle("api:test:three", async () => "three");

    ipcLayer.removeAllHandlers();

    const state = ipcLayer._getState();
    expect(state.handlers.size).toBe(0);
  });

  it("is idempotent when no handlers registered", () => {
    // Should not throw
    expect(() => ipcLayer.removeAllHandlers()).not.toThrow();

    const state = ipcLayer._getState();
    expect(state.handlers.size).toBe(0);
  });

  it("allows registration after removeAll", () => {
    ipcLayer.handle("api:test:channel", async () => "first");
    ipcLayer.removeAllHandlers();
    ipcLayer.handle("api:test:channel", async () => "second");

    const state = ipcLayer._getState();
    expect(state.handlers.has("api:test:channel")).toBe(true);
  });
});

describe("IpcLayer._invoke (test helper)", () => {
  let ipcLayer: BehavioralIpcLayer;

  beforeEach(() => {
    ipcLayer = createBehavioralIpcLayer();
  });

  it("invokes registered handler with arguments", async () => {
    ipcLayer.handle("api:test:echo", async (_event, payload) => payload);

    const result = await ipcLayer._invoke("api:test:echo", { message: "hello" });
    expect(result).toEqual({ message: "hello" });
  });

  it("throws PlatformError for non-existent channel", () => {
    expect(() => ipcLayer._invoke("api:nonexistent")).toThrow(PlatformError);
  });

  it("invocation error has correct code", () => {
    try {
      ipcLayer._invoke("api:nonexistent");
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe("IPC_HANDLER_NOT_FOUND");
    }
  });
});
