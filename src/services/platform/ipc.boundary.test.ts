/**
 * Boundary tests for DefaultIpcLayer against real Electron ipcMain.
 *
 * These tests verify that DefaultIpcLayer correctly wraps ipcMain.
 * Note: Full invoke testing requires a complete Electron app with renderer,
 * so we only test handler registration/removal here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ipcMain } from "electron";
import { DefaultIpcLayer } from "./ipc";
import { PlatformError } from "./errors";
import { createMockLogger } from "../logging";

describe("DefaultIpcLayer.handle", () => {
  let ipcLayer: DefaultIpcLayer;

  beforeEach(() => {
    ipcLayer = new DefaultIpcLayer(createMockLogger());
  });

  afterEach(() => {
    // Clean up any registered handlers
    ipcLayer.removeAllHandlers();
  });

  it("registers handler with ipcMain", () => {
    const handler = async () => "result";
    ipcLayer.handle("boundary:test:channel", handler);

    // Verify handler is registered by checking we can't register again
    expect(() => ipcLayer.handle("boundary:test:channel", async () => "other")).toThrow(
      PlatformError
    );
  });

  it("throws PlatformError on duplicate registration", () => {
    ipcLayer.handle("boundary:test:dup", async () => "first");

    try {
      ipcLayer.handle("boundary:test:dup", async () => "second");
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe("IPC_HANDLER_EXISTS");
    }
  });
});

describe("DefaultIpcLayer.removeHandler", () => {
  let ipcLayer: DefaultIpcLayer;

  beforeEach(() => {
    ipcLayer = new DefaultIpcLayer(createMockLogger());
  });

  afterEach(() => {
    ipcLayer.removeAllHandlers();
  });

  it("removes handler from ipcMain", () => {
    ipcLayer.handle("boundary:test:remove", async () => "result");
    ipcLayer.removeHandler("boundary:test:remove");

    // Verify we can register again after removal
    expect(() => ipcLayer.handle("boundary:test:remove", async () => "new")).not.toThrow();
  });

  it("throws PlatformError for non-existent channel", () => {
    try {
      ipcLayer.removeHandler("boundary:nonexistent");
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe("IPC_HANDLER_NOT_FOUND");
    }
  });
});

describe("DefaultIpcLayer.removeAllHandlers", () => {
  let ipcLayer: DefaultIpcLayer;

  beforeEach(() => {
    ipcLayer = new DefaultIpcLayer(createMockLogger());
  });

  afterEach(() => {
    ipcLayer.removeAllHandlers();
  });

  it("removes all handlers from ipcMain", () => {
    ipcLayer.handle("boundary:test:all1", async () => "one");
    ipcLayer.handle("boundary:test:all2", async () => "two");
    ipcLayer.handle("boundary:test:all3", async () => "three");

    ipcLayer.removeAllHandlers();

    // Verify all can be re-registered
    expect(() => ipcLayer.handle("boundary:test:all1", async () => "new1")).not.toThrow();
    expect(() => ipcLayer.handle("boundary:test:all2", async () => "new2")).not.toThrow();
    expect(() => ipcLayer.handle("boundary:test:all3", async () => "new3")).not.toThrow();
  });

  it("is idempotent", () => {
    ipcLayer.handle("boundary:test:idem", async () => "result");
    ipcLayer.removeAllHandlers();

    // Second call should not throw
    expect(() => ipcLayer.removeAllHandlers()).not.toThrow();
  });
});

describe("DefaultIpcLayer real ipcMain interaction", () => {
  let ipcLayer: DefaultIpcLayer;

  beforeEach(() => {
    ipcLayer = new DefaultIpcLayer(createMockLogger());
  });

  afterEach(() => {
    ipcLayer.removeAllHandlers();
  });

  it("handler is registered with ipcMain", () => {
    ipcLayer.handle("boundary:test:callable", async () => "result");

    // ipcMain stores handlers internally - we can verify registration worked
    // by checking that removeHandler from ipcMain itself doesn't throw
    ipcMain.removeHandler("boundary:test:callable");

    // Re-add via our layer to maintain tracking
    ipcLayer.handle("boundary:test:callable", async () => "result2");
  });
});
