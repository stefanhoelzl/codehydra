/**
 * Tests for DefaultViewBoundary against a fake window webContents.
 *
 * The view boundary adopts the window's own webContents; these tests drive the
 * real installChildFrameScript did-frame-finish-load injection path through a
 * fake webContents supplied by a stub WindowBoundary.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../platform/logging";
import type { WindowBoundary } from "./window";
import type { WindowHandle } from "./types";

type FrameLoadListener = (
  event: unknown,
  isMainFrame: boolean,
  frameProcessId: number,
  frameRoutingId: number
) => void;

interface FakeFrame {
  processId: number;
  routingId: number;
  executeJavaScript: ReturnType<typeof vi.fn>;
}

const listeners = new Map<string, FrameLoadListener[]>();
let frames: FakeFrame[] = [];

const fakeWebContents = {
  isDestroyed: () => false,
  on: (event: string, listener: FrameLoadListener) => {
    const list = listeners.get(event) ?? [];
    list.push(listener);
    listeners.set(event, list);
  },
  get mainFrame() {
    return { framesInSubtree: frames };
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

describe("DefaultViewBoundary installChildFrameScript", () => {
  let boundary: DefaultViewBoundary;

  beforeEach(() => {
    listeners.clear();
    frames = [];
    boundary = new DefaultViewBoundary(windowLayer, createMockLogger());
  });

  it("injects the script into matching child frames", () => {
    const frame: FakeFrame = {
      processId: 1,
      routingId: 7,
      executeJavaScript: vi.fn().mockResolvedValue(undefined),
    };
    frames = [frame];
    const handle = boundary.adoptWindowWebContents(windowHandle);

    boundary.installChildFrameScript(handle, "tracker()");
    emitFrameFinishLoad(false, 1, 7);

    expect(frame.executeJavaScript).toHaveBeenCalledWith("tracker()");
  });

  it("ignores main-frame loads", () => {
    const frame: FakeFrame = {
      processId: 1,
      routingId: 7,
      executeJavaScript: vi.fn().mockResolvedValue(undefined),
    };
    frames = [frame];
    const handle = boundary.adoptWindowWebContents(windowHandle);

    boundary.installChildFrameScript(handle, "tracker()");
    emitFrameFinishLoad(true, 1, 7);

    expect(frame.executeJavaScript).not.toHaveBeenCalled();
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
    const frame: FakeFrame = {
      processId: 1,
      routingId: 7,
      executeJavaScript: vi.fn().mockReturnValue(trackedPromise),
    };
    frames = [frame];
    const handle = boundary.adoptWindowWebContents(windowHandle);

    boundary.installChildFrameScript(handle, "tracker()");
    emitFrameFinishLoad(false, 1, 7);

    expect(frame.executeJavaScript).toHaveBeenCalledWith("tracker()");
    expect(rejectionHandled).toBe(true);
  });
});
