/**
 * Tests for DefaultViewBoundary against a fake window webContents.
 *
 * The view boundary adopts the window's own webContents; these tests drive the
 * real installChildFrameScript did-frame-finish-load injection path through a
 * fake webContents supplied by a stub WindowBoundary, with frame lookups going
 * through the shared `electron` fake's `webFrameMain.fromId`.
 *
 * The handler runs on a native Electron emit, so nothing it does may throw:
 * an escaping error lands in process.on("uncaughtException"), which
 * error-report-module answers with exit(1). Most cases below are that guard.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../platform/logging";
import { webFrameMain, webFrameMainState, resetElectronFake } from "../../test/mocks/electron";
import type { MockLogger } from "../platform/logging.test-utils";
import type { WindowBoundary } from "./window";
import type { WindowHandle } from "./types";

vi.mock("electron");

type FrameLoadListener = (
  event: unknown,
  isMainFrame: boolean,
  frameProcessId: number,
  frameRoutingId: number
) => void;

interface FakeFrame {
  executeJavaScript: ReturnType<typeof vi.fn>;
}

const listeners = new Map<string, FrameLoadListener[]>();

const fakeWebContents = {
  isDestroyed: () => false,
  on: (event: string, listener: FrameLoadListener) => {
    const list = listeners.get(event) ?? [];
    list.push(listener);
    listeners.set(event, list);
  },
  // Poisoned on purpose. Scanning `mainFrame.framesInSubtree` to find the
  // loaded frame is what crashed the app: that getter returns `undefined`
  // (silently, no throw) whenever any frame in the subtree is mid-deletion,
  // so `.find()` blew up on undefined. Reintroducing the scan must fail here.
  get mainFrame(): never {
    throw new Error("mainFrame must not be touched by installChildFrameScript");
  },
};

const windowLayer = {
  getWebContents: () => fakeWebContents,
} as unknown as WindowBoundary;

const windowHandle: WindowHandle = { id: "window-1", __brand: "WindowHandle" };

import { DefaultViewBoundary } from "./view";

function emitFrameFinishLoad(isMainFrame: boolean, processId: number, routingId: number): void {
  for (const listener of listeners.get("did-frame-finish-load") ?? []) {
    listener(undefined, isMainFrame, processId, routingId);
  }
}

function createFrame(): FakeFrame {
  return { executeJavaScript: vi.fn().mockResolvedValue(undefined) };
}

describe("DefaultViewBoundary installChildFrameScript", () => {
  let boundary: DefaultViewBoundary;
  let logger: MockLogger;

  beforeEach(() => {
    listeners.clear();
    resetElectronFake();
    logger = createMockLogger();
    boundary = new DefaultViewBoundary(windowLayer, logger);
  });

  it("injects the script into the frame identified by the event", () => {
    const frame = createFrame();
    webFrameMainState.lookup = (processId, routingId) =>
      processId === 1 && routingId === 7 ? frame : undefined;
    const handle = boundary.adoptWindowWebContents(windowHandle);

    boundary.installChildFrameScript(handle, "tracker()");
    emitFrameFinishLoad(false, 1, 7);

    expect(webFrameMain.fromId).toHaveBeenCalledWith(1, 7);
    expect(frame.executeJavaScript).toHaveBeenCalledWith("tracker()");
  });

  it("ignores main-frame loads", () => {
    const frame = createFrame();
    webFrameMainState.lookup = () => frame;
    const handle = boundary.adoptWindowWebContents(windowHandle);

    boundary.installChildFrameScript(handle, "tracker()");
    emitFrameFinishLoad(true, 1, 7);

    expect(webFrameMain.fromId).not.toHaveBeenCalled();
    expect(frame.executeJavaScript).not.toHaveBeenCalled();
  });

  it("skips frames that are already gone", () => {
    // fromId returns undefined once the frame has been deleted.
    webFrameMainState.lookup = () => undefined;
    const handle = boundary.adoptWindowWebContents(windowHandle);

    boundary.installChildFrameScript(handle, "tracker()");

    expect(() => emitFrameFinishLoad(false, 1, 7)).not.toThrow();
  });

  it("survives a frame lookup that throws", () => {
    // Electron throws this when the render frame is disposed mid-lookup.
    webFrameMainState.lookup = () => {
      throw new Error("Render frame was disposed before WebFrameMain could be accessed");
    };
    const handle = boundary.adoptWindowWebContents(windowHandle);

    boundary.installChildFrameScript(handle, "tracker()");

    expect(() => emitFrameFinishLoad(false, 1, 7)).not.toThrow();
    expect(logger.debug).toHaveBeenCalledWith(
      "Child frame script injection skipped",
      expect.objectContaining({
        error: "Render frame was disposed before WebFrameMain could be accessed",
      })
    );
  });

  it("survives a frame lookup that returns a malformed frame", () => {
    // Guards the whole handler body, not just the lookup: whatever shape a
    // teardown race hands back, the emit must not carry an error out.
    webFrameMainState.lookup = () => ({}) as unknown;
    const handle = boundary.adoptWindowWebContents(windowHandle);

    boundary.installChildFrameScript(handle, "tracker()");

    expect(() => emitFrameFinishLoad(false, 1, 7)).not.toThrow();
    expect(logger.debug).toHaveBeenCalledWith(
      "Child frame script injection skipped",
      expect.objectContaining({ id: handle.id })
    );
  });

  it("survives executeJavaScript throwing synchronously", () => {
    const frame = {
      executeJavaScript: vi.fn(() => {
        throw new Error("Object has been destroyed");
      }),
    };
    webFrameMainState.lookup = () => frame;
    const handle = boundary.adoptWindowWebContents(windowHandle);

    boundary.installChildFrameScript(handle, "tracker()");

    expect(() => emitFrameFinishLoad(false, 1, 7)).not.toThrow();
  });

  it("attaches a rejection handler to the injection promise", () => {
    // Electron rejects with "Script not run" when the frame's renderer goes
    // away before the script executes; without a handler this becomes an
    // unhandled rejection that error-report-module reports as a crash.
    let rejectionHandled = false;
    const trackedPromise = {
      then: (_onFulfilled?: unknown, onRejected?: unknown) => {
        if (onRejected) rejectionHandled = true;
        return Promise.resolve();
      },
      catch: () => {
        rejectionHandled = true;
        return Promise.resolve();
      },
    };
    const frame = { executeJavaScript: vi.fn().mockReturnValue(trackedPromise) };
    webFrameMainState.lookup = () => frame;
    const handle = boundary.adoptWindowWebContents(windowHandle);

    boundary.installChildFrameScript(handle, "tracker()");
    emitFrameFinishLoad(false, 1, 7);

    expect(frame.executeJavaScript).toHaveBeenCalledWith("tracker()");
    expect(rejectionHandled).toBe(true);
  });
});
