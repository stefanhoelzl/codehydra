/**
 * Tests for the WorkspaceFrames component.
 *
 * Frames come pre-filtered from the UiState snapshot (the presenter only
 * includes mountable workspaces); only the frame matching activeKey is
 * visible (.active). Focus side effects (rAF + contentWindow.focus) are not
 * observable in happy-dom — the tests cover mounting, visibility, and the
 * window hooks the main process calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "@testing-library/svelte";

import WorkspaceFrames from "./WorkspaceFrames.svelte";
import { createMockApi } from "../test-utils";

interface FrameHooks {
  __chFocusActiveFrame?: () => void;
  __chActiveFrameRect?: () => { x: number; y: number; width: number; height: number } | null;
  __chReloadFrames?: () => void;
}

const FRAMES = [
  { key: "test-12345678/ws1", url: "http://127.0.0.1:9000/?folder=/workspaces/ws1", title: "ws1" },
  { key: "test-12345678/ws2", url: "http://127.0.0.1:9000/?folder=/workspaces/ws2", title: "ws2" },
];

function frames(container: HTMLElement): HTMLIFrameElement[] {
  return [...container.querySelectorAll("iframe")];
}

describe("WorkspaceFrames", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("mounts one iframe per frame entry", () => {
    const { container } = render(WorkspaceFrames, {
      props: { frames: FRAMES, activeKey: null },
    });

    const els = frames(container);
    expect(els).toHaveLength(2);
    expect(els.map((el) => el.dataset.key).sort()).toEqual([
      "test-12345678/ws1",
      "test-12345678/ws2",
    ]);
    expect(els[0]!.src).toContain("folder=/workspaces/ws1");
    expect(els[0]!.title).toBe("Workspace ws1");
  });

  it("marks only the active frame as active", () => {
    const { container } = render(WorkspaceFrames, {
      props: { frames: FRAMES, activeKey: "test-12345678/ws2" },
    });

    const active = frames(container).filter((el) => el.classList.contains("active"));
    expect(active).toHaveLength(1);
    expect(active[0]!.dataset.key).toBe("test-12345678/ws2");
  });

  it("shows no active frame when activeKey is null", () => {
    const { container } = render(WorkspaceFrames, {
      props: { frames: FRAMES, activeKey: null },
    });

    expect(frames(container).some((el) => el.classList.contains("active"))).toBe(false);
  });

  it("unmounts a frame when it leaves the snapshot (hibernation)", async () => {
    const { container, rerender } = render(WorkspaceFrames, {
      props: { frames: FRAMES, activeKey: null },
    });
    expect(frames(container)).toHaveLength(2);

    await rerender({ frames: [FRAMES[0]!], activeKey: null });

    expect(frames(container)).toHaveLength(1);
    expect(frames(container)[0]!.dataset.key).toBe("test-12345678/ws1");
  });

  it("registers the main-process window hooks and removes them on unmount", () => {
    const hooks = window as FrameHooks;
    const { unmount } = render(WorkspaceFrames, {
      props: { frames: FRAMES, activeKey: null },
    });

    expect(typeof hooks.__chFocusActiveFrame).toBe("function");
    expect(typeof hooks.__chActiveFrameRect).toBe("function");
    expect(typeof hooks.__chReloadFrames).toBe("function");

    unmount();
    expect(hooks.__chFocusActiveFrame).toBeUndefined();
    expect(hooks.__chActiveFrameRect).toBeUndefined();
    expect(hooks.__chReloadFrames).toBeUndefined();
  });

  it("__chReloadFrames re-assigns the src of every mounted frame", () => {
    const { container } = render(WorkspaceFrames, {
      props: { frames: FRAMES, activeKey: "test-12345678/ws1" },
    });

    // Re-assigning src forces a reload; spy on the setter of each frame while
    // keeping the original URL readable. Both mounted frames should be touched.
    const tracked = frames(container).map((el) => {
      const original = el.src;
      const setter = vi.fn();
      Object.defineProperty(el, "src", {
        configurable: true,
        get: () => original,
        set: setter,
      });
      return { setter, original };
    });
    expect(tracked).toHaveLength(2);

    const hooks = window as FrameHooks;
    hooks.__chReloadFrames!();

    for (const { setter, original } of tracked) {
      expect(setter).toHaveBeenCalledWith(original);
    }
  });

  it("__chActiveFrameRect returns null when no frame is active", () => {
    render(WorkspaceFrames, { props: { frames: FRAMES, activeKey: null } });

    const hooks = window as FrameHooks;
    expect(hooks.__chActiveFrameRect!()).toBeNull();
  });

  // ===========================================================================
  // Liveness
  //
  // Showing a frame pings it; a frame that does not answer is logged. The
  // frames are the only witnesses to their shared renderer process dying —
  // Electron reports no event for a subframe process. Detection logs; it never
  // reloads.
  // ===========================================================================

  describe("liveness", () => {
    /** happy-dom leaves contentWindow null, so give each frame an identity. */
    function giveWindows(container: HTMLElement): Map<string, { pings: unknown[] }> {
      const windows = new Map<string, { pings: unknown[] }>();
      for (const el of frames(container)) {
        const win = {
          pings: [] as unknown[],
          postMessage: (message: unknown) => win.pings.push(message),
        };
        Object.defineProperty(el, "contentWindow", { configurable: true, value: win });
        windows.set(el.dataset.key!, win);
      }
      return windows;
    }

    /** Answer a probe as the given frame. */
    function answer(source: object): void {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { __chAlive: true },
          source: source as MessageEventSource,
        })
      );
    }

    /** The log events the component emitted through the renderer logger. */
    function logs() {
      return vi
        .mocked(window.api.emitEvent)
        .mock.calls.map(([event]) => event)
        .filter((event): event is Extract<typeof event, { kind: "log" }> => event.kind === "log")
        .map(({ level, message, context }) => ({ level, message, context }));
    }

    beforeEach(() => {
      vi.useFakeTimers();
      window.api = createMockApi();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("pings the frame being shown, and only that one", async () => {
      const { container, rerender } = render(WorkspaceFrames, {
        props: { frames: FRAMES, activeKey: null },
      });
      const windows = giveWindows(container);

      await rerender({ frames: FRAMES, activeKey: FRAMES[0]!.key });

      expect(windows.get("test-12345678/ws1")!.pings).toEqual([{ __chPing: true }]);
      expect(windows.get("test-12345678/ws2")!.pings).toEqual([]);
    });

    it("checks once per switch, not again when the mounted set changes", async () => {
      const { container, rerender } = render(WorkspaceFrames, {
        props: { frames: FRAMES, activeKey: null },
      });
      const windows = giveWindows(container);

      await rerender({ frames: FRAMES, activeKey: FRAMES[0]!.key });
      // ws2 hibernates while ws1 stays on screen: no new verdict on ws1.
      await rerender({ frames: [FRAMES[0]!], activeKey: FRAMES[0]!.key });

      expect(windows.get("test-12345678/ws1")!.pings).toEqual([{ __chPing: true }]);
    });

    it("checks again when the same frame is shown a second time", async () => {
      const { container, rerender } = render(WorkspaceFrames, {
        props: { frames: FRAMES, activeKey: null },
      });
      const windows = giveWindows(container);

      await rerender({ frames: FRAMES, activeKey: FRAMES[0]!.key });
      answer(windows.get("test-12345678/ws1")!);
      await rerender({ frames: FRAMES, activeKey: FRAMES[1]!.key });
      answer(windows.get("test-12345678/ws2")!);
      await rerender({ frames: FRAMES, activeKey: FRAMES[0]!.key });

      expect(windows.get("test-12345678/ws1")!.pings).toEqual([
        { __chPing: true },
        { __chPing: true },
      ]);
    });

    it("logs a shown frame that never answers", async () => {
      const { container, rerender } = render(WorkspaceFrames, {
        props: { frames: FRAMES, activeKey: null },
      });
      giveWindows(container);

      await rerender({ frames: FRAMES, activeKey: FRAMES[0]!.key });
      await vi.advanceTimersByTimeAsync(6_000);

      expect(logs()).toEqual([
        {
          level: "warn",
          message: "Workspace frame never responded (may never have finished loading)",
          context: { key: "test-12345678/ws1" },
        },
      ]);
    });

    it("stays quiet when the frame answers the probe", async () => {
      const { container, rerender } = render(WorkspaceFrames, {
        props: { frames: FRAMES, activeKey: null },
      });
      const windows = giveWindows(container);

      await rerender({ frames: FRAMES, activeKey: FRAMES[0]!.key });
      answer(windows.get("test-12345678/ws1")!);
      await vi.advanceTimersByTimeAsync(6_000);

      expect(logs()).toEqual([]);
      expect(windows.get("test-12345678/ws1")!.pings).toEqual([{ __chPing: true }]);
    });

    it("reports a frame that answered before differently from one that never did", async () => {
      const { container, rerender } = render(WorkspaceFrames, {
        props: { frames: FRAMES, activeKey: null },
      });
      const windows = giveWindows(container);

      // ws1 answers once, so it is known-good...
      await rerender({ frames: FRAMES, activeKey: FRAMES[0]!.key });
      answer(windows.get("test-12345678/ws1")!);
      // ...then goes away and stops answering when shown again.
      await rerender({ frames: FRAMES, activeKey: FRAMES[1]!.key });
      answer(windows.get("test-12345678/ws2")!);
      await rerender({ frames: FRAMES, activeKey: FRAMES[0]!.key });
      await vi.advanceTimersByTimeAsync(6_000);

      expect(logs()).toEqual([
        {
          level: "warn",
          message: "Workspace frame stopped responding (renderer may have died)",
          context: { key: "test-12345678/ws1" },
        },
      ]);
    });

    it("drops the verdict when the shown frame changes before it lands", async () => {
      const { container, rerender } = render(WorkspaceFrames, {
        props: { frames: FRAMES, activeKey: null },
      });
      const windows = giveWindows(container);

      await rerender({ frames: FRAMES, activeKey: FRAMES[0]!.key });
      await vi.advanceTimersByTimeAsync(2_000);
      // Switched away before ws1's probe timed out: only ws2 is judged.
      await rerender({ frames: FRAMES, activeKey: FRAMES[1]!.key });
      answer(windows.get("test-12345678/ws2")!);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(logs()).toEqual([]);
    });

    it("does not judge a frame while nothing is shown", async () => {
      const { container, rerender } = render(WorkspaceFrames, {
        props: { frames: FRAMES, activeKey: FRAMES[0]!.key },
      });
      giveWindows(container);

      await rerender({ frames: FRAMES, activeKey: null });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(logs()).toEqual([]);
    });

    it("does not read a reload as a death", async () => {
      const { container, rerender } = render(WorkspaceFrames, {
        props: { frames: FRAMES, activeKey: null },
      });
      giveWindows(container);

      await rerender({ frames: FRAMES, activeKey: FRAMES[0]!.key });
      (window as FrameHooks).__chReloadFrames!();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(logs()).toEqual([]);
    });

    it("ignores answers that are not from a mounted frame", async () => {
      const { container, rerender } = render(WorkspaceFrames, {
        props: { frames: FRAMES, activeKey: null },
      });
      giveWindows(container);

      await rerender({ frames: FRAMES, activeKey: FRAMES[0]!.key });
      // A stray postMessage from an unrelated window must not clear the probe.
      answer({});
      await vi.advanceTimersByTimeAsync(6_000);

      expect(logs().map((entry) => entry.context?.["key"])).toEqual(["test-12345678/ws1"]);
    });
  });
});
