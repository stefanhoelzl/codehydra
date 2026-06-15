/**
 * Integration tests for IpcBoundary using behavioral mock.
 *
 * These tests verify the IpcBoundary interface contract using the behavioral mock.
 * The boundary tests verify the same behavior against real Electron ipcMain.
 *
 * IpcBoundary is fire-and-forget only (on/removeListener); renderer→main
 * gestures flow through the `api:ui:event` channel as listeners.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createBehavioralIpcBoundary, type BehavioralIpcBoundary } from "./ipc.test-utils";

describe("IpcBoundary.on", () => {
  let ipcLayer: BehavioralIpcBoundary;

  beforeEach(() => {
    ipcLayer = createBehavioralIpcBoundary();
  });

  it("registers a listener for a channel", () => {
    const listener = vi.fn();
    ipcLayer.on("api:test:channel", listener);

    expect(ipcLayer._getListeners("api:test:channel")).toHaveLength(1);
  });

  it("allows multiple listeners on the same channel", () => {
    ipcLayer.on("api:test:channel", vi.fn());
    ipcLayer.on("api:test:channel", vi.fn());

    expect(ipcLayer._getListeners("api:test:channel")).toHaveLength(2);
  });

  it("keeps listeners on different channels separate", () => {
    ipcLayer.on("api:test:one", vi.fn());
    ipcLayer.on("api:test:two", vi.fn());

    expect(ipcLayer._getListeners("api:test:one")).toHaveLength(1);
    expect(ipcLayer._getListeners("api:test:two")).toHaveLength(1);
  });

  it("returns an empty list for an unregistered channel", () => {
    expect(ipcLayer._getListeners("api:nonexistent")).toHaveLength(0);
  });
});

describe("IpcBoundary._emit (test helper)", () => {
  let ipcLayer: BehavioralIpcBoundary;

  beforeEach(() => {
    ipcLayer = createBehavioralIpcBoundary();
  });

  it("invokes all registered listeners with the payload", () => {
    const a = vi.fn();
    const b = vi.fn();
    ipcLayer.on("api:test:channel", a);
    ipcLayer.on("api:test:channel", b);

    ipcLayer._emit("api:test:channel", { message: "hello" });

    expect(a).toHaveBeenCalledWith(expect.anything(), { message: "hello" });
    expect(b).toHaveBeenCalledWith(expect.anything(), { message: "hello" });
  });

  it("does nothing for a channel with no listeners", () => {
    expect(() => ipcLayer._emit("api:nonexistent", {})).not.toThrow();
  });
});

describe("IpcBoundary.removeListener", () => {
  let ipcLayer: BehavioralIpcBoundary;

  beforeEach(() => {
    ipcLayer = createBehavioralIpcBoundary();
  });

  it("removes a specific listener by reference", () => {
    const a = vi.fn();
    const b = vi.fn();
    ipcLayer.on("api:test:channel", a);
    ipcLayer.on("api:test:channel", b);

    ipcLayer.removeListener("api:test:channel", a);

    const remaining = ipcLayer._getListeners("api:test:channel");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(b);
  });

  it("a removed listener is no longer invoked on emit", () => {
    const listener = vi.fn();
    ipcLayer.on("api:test:channel", listener);
    ipcLayer.removeListener("api:test:channel", listener);

    ipcLayer._emit("api:test:channel", {});

    expect(listener).not.toHaveBeenCalled();
  });

  it("is a no-op for an unregistered channel", () => {
    expect(() => ipcLayer.removeListener("api:nonexistent", vi.fn())).not.toThrow();
  });
});
