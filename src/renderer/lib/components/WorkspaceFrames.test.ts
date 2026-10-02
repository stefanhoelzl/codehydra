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
  __chReloadFrame?: (key: string) => void;
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
    expect(typeof hooks.__chReloadFrame).toBe("function");

    unmount();
    expect(hooks.__chFocusActiveFrame).toBeUndefined();
    expect(hooks.__chActiveFrameRect).toBeUndefined();
    expect(hooks.__chReloadFrames).toBeUndefined();
    expect(hooks.__chReloadFrame).toBeUndefined();
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

  it("__chReloadFrame re-assigns the src of only the named frame", () => {
    const { container } = render(WorkspaceFrames, {
      props: { frames: FRAMES, activeKey: "test-12345678/ws1" },
    });

    const tracked = frames(container).map((el) => {
      const original = el.src;
      const setter = vi.fn();
      Object.defineProperty(el, "src", {
        configurable: true,
        get: () => original,
        set: setter,
      });
      return { key: el.dataset.key, setter, original };
    });

    const hooks = window as FrameHooks;
    hooks.__chReloadFrame!("test-12345678/ws2");

    const ws1 = tracked.find((t) => t.key === "test-12345678/ws1")!;
    const ws2 = tracked.find((t) => t.key === "test-12345678/ws2")!;
    expect(ws2.setter).toHaveBeenCalledWith(ws2.original);
    expect(ws1.setter).not.toHaveBeenCalled();
  });

  it("__chReloadFrame ignores a key with no mounted frame", () => {
    render(WorkspaceFrames, { props: { frames: FRAMES, activeKey: null } });

    const hooks = window as FrameHooks;
    expect(() => hooks.__chReloadFrame!("test-12345678/gone")).not.toThrow();
  });

  it("__chActiveFrameRect returns null when no frame is active", () => {
    render(WorkspaceFrames, { props: { frames: FRAMES, activeKey: null } });

    const hooks = window as FrameHooks;
    expect(hooks.__chActiveFrameRect!()).toBeNull();
  });

  // ===========================================================================
  // Focus repair
  //
  // A hidden frame can still take focus from the visible one: window.focus()
  // is frame-level, so Chromium honours it even for a display:none iframe, and
  // VS Code's webview bootstrap makes that call. Focus then sits where nothing
  // is focusable and keystrokes vanish (PostHog issue 019fc47f). The frame that
  // lost it reports __chBlurred and the active frame is focused again.
  // ===========================================================================

  describe("focus repair", () => {
    /** happy-dom leaves contentWindow null, so give each frame a spyable one. */
    function giveWindows(container: HTMLElement): Map<string, { focus: ReturnType<typeof vi.fn> }> {
      const windows = new Map<string, { focus: ReturnType<typeof vi.fn> }>();
      for (const el of frames(container)) {
        const win = { focus: vi.fn(), postMessage: vi.fn() };
        Object.defineProperty(el, "contentWindow", { configurable: true, value: win });
        windows.set(el.dataset.key!, win);
      }
      return windows;
    }

    /** Report, as `source`, that focus left that frame. */
    function reportBlur(source: object): void {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { __chBlurred: true },
          source: source as MessageEventSource,
        })
      );
      vi.advanceTimersByTime(50);
    }

    beforeEach(() => {
      vi.useFakeTimers();
      window.api = createMockApi();
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    /** Render with the active frame settled, so only repairs are observed. */
    function setup(mode: "workspace" | "hover" | "shortcut" | "dialog" = "workspace") {
      const rendered = render(WorkspaceFrames, {
        props: { frames: FRAMES, activeKey: FRAMES[0]!.key, mode },
      });
      const windows = giveWindows(rendered.container);
      vi.advanceTimersByTime(50);
      for (const win of windows.values()) win.focus.mockClear();
      return { ...rendered, windows };
    }

    it("focuses the active frame again after another frame takes focus", () => {
      const { windows } = setup();

      reportBlur(windows.get(FRAMES[0]!.key)!);

      expect(windows.get(FRAMES[0]!.key)!.focus).toHaveBeenCalled();
    });

    it("ignores a blur reported by a frame that is not the active one", () => {
      const { windows } = setup();

      reportBlur(windows.get(FRAMES[1]!.key)!);

      expect(windows.get(FRAMES[0]!.key)!.focus).not.toHaveBeenCalled();
    });

    it("repairs while the sidebar is hovered", () => {
      // The pointer resting over the sidebar says nothing about where the user
      // is typing, so hover must not switch the protection off.
      const { windows } = setup("hover");

      reportBlur(windows.get(FRAMES[0]!.key)!);

      expect(windows.get(FRAMES[0]!.key)!.focus).toHaveBeenCalled();
    });

    it("leaves focus alone in shortcut mode, which blurs the frame on purpose", () => {
      const { windows } = setup("shortcut");

      reportBlur(windows.get(FRAMES[0]!.key)!);

      expect(windows.get(FRAMES[0]!.key)!.focus).not.toHaveBeenCalled();
    });

    it("leaves focus alone while a dialog owns it", () => {
      const { windows } = setup("dialog");

      reportBlur(windows.get(FRAMES[0]!.key)!);

      expect(windows.get(FRAMES[0]!.key)!.focus).not.toHaveBeenCalled();
    });

    it("does not reclaim focus the whole window has lost", () => {
      const { windows } = setup();
      vi.mocked(document.hasFocus).mockReturnValue(false);

      reportBlur(windows.get(FRAMES[0]!.key)!);

      expect(windows.get(FRAMES[0]!.key)!.focus).not.toHaveBeenCalled();
    });

    it("gives up on a frame that keeps stealing, rather than fighting it", () => {
      const { windows } = setup();
      const active = windows.get(FRAMES[0]!.key)!;

      for (let i = 0; i < 6; i++) reportBlur(active);

      // Bounded: the caret is left where it is rather than ping-ponging.
      expect(active.focus.mock.calls.length).toBeLessThan(6);
    });
  });

  // ===========================================================================
  // Focus policy
  //
  // The workbench focuses itself on its own schedule (at startup, among
  // others), pulling the caret out of a dialog's field. Each frame is told
  // whether it may take focus on its own, and a gate patched into the workbench
  // enforces it (bundle-patches.ts, FOCUS_GATE).
  // ===========================================================================

  describe("focus policy", () => {
    /** happy-dom leaves contentWindow null, so give each frame a recording one. */
    function giveWindows(container: HTMLElement): Map<string, { policies: boolean[] }> {
      const windows = new Map<string, { policies: boolean[] }>();
      for (const el of frames(container)) {
        const win = {
          policies: [] as boolean[],
          focus: vi.fn(),
          postMessage: (message: { __chFocusAllowed?: unknown }) => {
            if (typeof message.__chFocusAllowed === "boolean")
              win.policies.push(message.__chFocusAllowed);
          },
        };
        Object.defineProperty(el, "contentWindow", { configurable: true, value: win });
        windows.set(el.dataset.key!, win);
      }
      return windows;
    }

    /** As `source`, ask for this frame's policy, the way the gate does on load. */
    function requestPolicy(source: object): void {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { __chFocusPolicyRequest: true },
          source: source as MessageEventSource,
        })
      );
    }

    beforeEach(() => {
      window.api = createMockApi();
    });

    function setup(mode: "workspace" | "hover" | "shortcut" | "dialog") {
      const props = { frames: FRAMES, activeKey: FRAMES[0]!.key, mode };
      const rendered = render(WorkspaceFrames, { props });
      const windows = giveWindows(rendered.container);
      const active = windows.get(FRAMES[0]!.key)!;
      const hidden = windows.get(FRAMES[1]!.key)!;
      return { ...rendered, props, active, hidden };
    }

    it("lets the active frame take focus while it owns the keyboard", () => {
      const { active } = setup("workspace");

      requestPolicy(active);

      expect(active.policies).toEqual([true]);
    });

    it("keeps the sidebar hover from taking that away", () => {
      const { active } = setup("hover");

      requestPolicy(active);

      expect(active.policies).toEqual([true]);
    });

    it("never lets a hidden frame take focus", () => {
      // A background workbench focusing itself would take the keyboard from
      // the workspace on screen.
      const { hidden } = setup("workspace");

      requestPolicy(hidden);

      expect(hidden.policies).toEqual([false]);
    });

    it("lets no frame take focus while a dialog owns the keyboard", () => {
      const { active } = setup("dialog");

      requestPolicy(active);

      expect(active.policies).toEqual([false]);
    });

    it("lets no frame take focus in shortcut mode", () => {
      const { active } = setup("shortcut");

      requestPolicy(active);

      expect(active.policies).toEqual([false]);
    });

    it("withdraws it from the active frame the moment a dialog opens", async () => {
      const { active, props, rerender } = setup("workspace");

      await rerender({ ...props, mode: "dialog" });

      expect(active.policies.at(-1)).toBe(false);
    });

    it("moves it to the frame being switched to", async () => {
      const { active, hidden, props, rerender } = setup("workspace");

      await rerender({ ...props, activeKey: FRAMES[1]!.key });

      expect(active.policies.at(-1)).toBe(false);
      expect(hidden.policies.at(-1)).toBe(true);
    });

    it("withdraws it while an element of this page holds focus", async () => {
      // The mode reaches the renderer only after a round trip through main, so
      // a dialog's field can hold the caret while the mode still says "hover".
      const { active } = setup("hover");
      const input = document.createElement("input");
      document.body.appendChild(input);

      input.focus();
      await Promise.resolve();

      expect(active.policies.at(-1)).toBe(false);
    });

    it("gives it back once this page lets go of focus", async () => {
      vi.useFakeTimers();
      const { active } = setup("workspace");
      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();
      await Promise.resolve();

      input.blur();
      vi.advanceTimersByTime(10);
      await Promise.resolve();

      expect(active.policies.at(-1)).toBe(true);
      vi.useRealTimers();
    });

    it("ignores a request from something that is not a mounted frame", () => {
      const { active, hidden } = setup("workspace");

      requestPolicy({});

      expect(active.policies).toEqual([]);
      expect(hidden.policies).toEqual([]);
    });
  });
});
