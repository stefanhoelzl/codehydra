/**
 * Tests for DefaultViewBoundary with a mocked Electron module.
 *
 * The behavioral mock (view.state-mock.ts) stubs installChildFrameScript,
 * so the real did-frame-finish-load injection path is covered here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../platform/logging";
import type { WindowBoundary } from "./window";

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

const { fakeState } = vi.hoisted(() => {
  const state = {
    listeners: new Map<string, FrameLoadListener[]>(),
    frames: [] as FakeFrame[],
  };
  return { fakeState: state };
});

vi.mock("electron", () => ({
  WebContentsView: class {
    setBackgroundColor = vi.fn();
    webContents = {
      isDestroyed: () => false,
      on: (event: string, listener: FrameLoadListener) => {
        const list = fakeState.listeners.get(event) ?? [];
        list.push(listener);
        fakeState.listeners.set(event, list);
      },
      get mainFrame() {
        return { framesInSubtree: fakeState.frames };
      },
    };
  },
}));

import { DefaultViewBoundary } from "./view";

function emitFrameFinishLoad(isMainFrame: boolean, processId: number, routingId: number): void {
  for (const listener of fakeState.listeners.get("did-frame-finish-load") ?? []) {
    listener(undefined, isMainFrame, processId, routingId);
  }
}

describe("DefaultViewBoundary installChildFrameScript", () => {
  let boundary: DefaultViewBoundary;

  beforeEach(() => {
    fakeState.listeners.clear();
    fakeState.frames = [];
    boundary = new DefaultViewBoundary({} as WindowBoundary, createMockLogger());
  });

  it("injects the script into matching child frames", () => {
    const frame: FakeFrame = {
      processId: 1,
      routingId: 7,
      executeJavaScript: vi.fn().mockResolvedValue(undefined),
    };
    fakeState.frames = [frame];
    const handle = boundary.createView({});

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
    fakeState.frames = [frame];
    const handle = boundary.createView({});

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
    fakeState.frames = [frame];
    const handle = boundary.createView({});

    boundary.installChildFrameScript(handle, "tracker()");
    emitFrameFinishLoad(false, 1, 7);

    expect(frame.executeJavaScript).toHaveBeenCalledWith("tracker()");
    expect(rejectionHandled).toBe(true);
  });
});
